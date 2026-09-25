/**
 * 单边重定向预览的测试：
 * 1. 固定场景：切换后目标隐藏、空陷阱前缀、重定向制造新陷阱、无解、
 *    ALREADY_SAFE、预览上限；
 * 2. 随机小图上独立枚举所有单边替换，逐一比对安全判定与预览结果；
 * 3. graphToJson 往返一致（应用重定向后同步导入框的前提）。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_ORDER,
  graphToJson,
  parseGraph,
  type ActionKind,
  type FocusGraph,
} from './model';
import { nextState, shortestToTarget, startState, trapPrefix } from './search';
import {
  applyRedirect,
  previewRedirect,
  REDIRECT_MAX_NODES,
  REDIRECT_MAX_SWITCHES,
  type RedirectCandidate,
} from './redirect';
import { SAMPLE_TEXT } from './sample';

function make(spec: unknown): FocusGraph {
  const r = parseGraph(spec);
  if (!r.ok) throw new Error(`测试图非法：${r.errors.join('；')}`);
  return r.graph;
}

// ---------------------------------------------------------------------------
// 独立参考实现（与 src/lib/redirect.ts 不共享代码）
// 状态用 "node:bits" 字符串编码，转移直接按字面量语义重算。
// ---------------------------------------------------------------------------

const key = (n: number, b: number) => `${n}:${b}`;

function refNext(g: FocusGraph, n: number, b: number, a: ActionKind): [number, number] | null {
  const e = g.edges[n][a];
  if (!e) return null;
  const nb = e.flip === null ? b : b ^ (1 << e.flip);
  const ok = g.conditions[e.to].every((l) => (((nb >> l.sw) & 1) === 1) === l.value);
  return ok ? [e.to, nb] : null;
}

/** 独立可达集：字符串状态 BFS */
function refReachable(g: FocusGraph): Set<string> {
  const start: [number, number] = [g.entry, 0];
  const seen = new Set([key(...start)]);
  const queue = [start];
  for (let h = 0; h < queue.length; h++) {
    const [n, b] = queue[h];
    for (const a of ACTION_ORDER) {
      const nx = refNext(g, n, b, a);
      if (!nx) continue;
      const k = key(...nx);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(nx);
      }
    }
  }
  return seen;
}

/** 独立 good 集：全部目标状态出发沿反向边洪泛 */
function refGood(g: FocusGraph): Set<string> {
  const S = 1 << g.switches.length;
  const preds = new Map<string, string[]>();
  for (let n = 0; n < g.nodes.length; n++) {
    for (let b = 0; b < S; b++) {
      for (const a of ACTION_ORDER) {
        const nx = refNext(g, n, b, a);
        if (!nx) continue;
        const k = key(...nx);
        if (!preds.has(k)) preds.set(k, []);
        preds.get(k)!.push(key(n, b));
      }
    }
  }
  const good = new Set<string>();
  const queue: string[] = [];
  for (let b = 0; b < S; b++) {
    good.add(key(g.target, b));
    queue.push(key(g.target, b));
  }
  for (let h = 0; h < queue.length; h++) {
    for (const p of preds.get(queue[h]) ?? []) {
      if (!good.has(p)) {
        good.add(p);
        queue.push(p);
      }
    }
  }
  return good;
}

/** 独立安全判定：入口可达的每个状态都能到达目标 */
function refSafe(g: FocusGraph): boolean {
  const good = refGood(g);
  for (const k of refReachable(g)) {
    if (!good.has(k)) return false;
  }
  return true;
}

/** 独立最短按键序列：字符串状态 BFS，按 ACTION_ORDER 展开 */
function refBfs(g: FocusGraph, isGoal: (n: number, b: number) => boolean): ActionKind[] | null {
  const start = key(g.entry, 0);
  const prev = new Map<string, { p: string; a: ActionKind }>();
  const seen = new Set([start]);
  const queue = [start];
  let goal: string | null = isGoal(g.entry, 0) ? start : null;
  for (let h = 0; h < queue.length && !goal; h++) {
    const cur = queue[h];
    const [n, b] = cur.split(':').map(Number);
    for (const a of ACTION_ORDER) {
      const nx = refNext(g, n, b, a);
      if (!nx) continue;
      const k = key(...nx);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, { p: cur, a });
      if (isGoal(nx[0], nx[1])) {
        goal = k;
        break;
      }
      queue.push(k);
    }
  }
  if (goal === null) return null;
  const acts: ActionKind[] = [];
  for (let c = goal; c !== start; c = prev.get(c)!.p) acts.push(prev.get(c)!.a);
  return acts.reverse();
}

const refWitnessActs = (g: FocusGraph): ActionKind[] | null => refBfs(g, (n) => n === g.target);

const refTrapActs = (g: FocusGraph): ActionKind[] | null => {
  const good = refGood(g);
  return refBfs(g, (n, b) => !good.has(key(n, b)));
};

/** 独立改图：逐条重建边表，仅替换指定动作的目标（翻转保留） */
function refModify(g: FocusGraph, c: RedirectCandidate): FocusGraph {
  return {
    ...g,
    edges: g.edges.map((ne, i) => ({
      tab:
        i === c.from && c.action === 'tab'
          ? { to: c.to, flip: ne.tab!.flip }
          : ne.tab && { ...ne.tab },
      shiftTab:
        i === c.from && c.action === 'shiftTab'
          ? { to: c.to, flip: ne.shiftTab!.flip }
          : ne.shiftTab && { ...ne.shiftTab },
      activate:
        i === c.from && c.action === 'activate'
          ? { to: c.to, flip: ne.activate!.flip }
          : ne.activate && { ...ne.activate },
    })),
  };
}

/** 按 （源节点 id, 动作优先级， 目标 id) 顺序枚举全部单边替换 */
function* allCandidates(g: FocusGraph): Generator<RedirectCandidate> {
  for (let from = 0; from < g.nodes.length; from++) {
    for (const action of ACTION_ORDER) {
      const e = g.edges[from][action];
      if (!e) continue;
      for (let to = 0; to < g.nodes.length; to++) {
        if (to !== e.to) yield { from, action, to };
      }
    }
  }
}

/** 独立预览：上限 12 节点 / 4 开关，枚举首个安全候选 */
function refPreview(g: FocusGraph) {
  if (g.nodes.length > 12 || g.switches.length > 4) return { status: 'TOO_LARGE' as const };
  const trap = refTrapActs(g);
  if (trap === null) return { status: 'ALREADY_SAFE' as const };
  const before = refWitnessActs(g);
  for (const c of allCandidates(g)) {
    const g2 = refModify(g, c);
    if (refSafe(g2)) {
      return { status: 'FOUND' as const, candidate: c, before, after: refWitnessActs(g2), eliminatedTrap: trap };
    }
  }
  return { status: 'NO_SINGLE_REDIRECT' as const };
}

// ---------------------------------------------------------------------------
// 固定场景
// ---------------------------------------------------------------------------

describe('单边重定向预览 · 固定场景', () => {
  it('内置示例（切换后目标隐藏）：最小安全候选是 hall 的激活改到 gate', () => {
    const g = make(SAMPLE_TEXT);
    const edgesBefore = JSON.stringify(g.edges);
    const p = previewRedirect(g);
    expect(p.status).toBe('FOUND');
    if (p.status !== 'FOUND') return;
    // gate 的 tab/shiftTab 改目标、hall 的 tab 改目标都无法消除陷阱；
    // 首个安全候选：hall(1) 的 activate 目标 cell(2) → gate(0)
    expect(p.candidate).toEqual({ from: 1, action: 'activate', to: 0 });
    expect(p.before!.actions).toEqual(['tab', 'tab']);
    expect(p.after.actions).toEqual(['tab', 'tab']);
    expect(p.eliminatedTrap.actions).toEqual(['tab', 'activate']);
    // 纯预览：原图不被修改
    expect(JSON.stringify(g.edges)).toBe(edgesBefore);
    // 应用后翻转开关保留，陷阱消除
    const g2 = applyRedirect(g, p.candidate);
    expect(g2.edges[1].activate).toEqual({ to: 0, flip: 0 });
    expect(trapPrefix(g2)).toBeNull();
    expect(previewRedirect(g2).status).toBe('ALREADY_SAFE');
  });

  it('重定向制造新陷阱的候选会被淘汰', () => {
    const g = make(SAMPLE_TEXT);
    // hall 的激活改到 mirror：Tab,激活 这条原陷阱路径被切断，
    // 但 lamp 打开后 hall 上两条边全部失效，(hall, lamp=开) 成为新的死局
    const bad = applyRedirect(g, { from: 1, action: 'activate', to: 4 });
    expect(trapPrefix(bad)).not.toBeNull();
    // 预览不会选择它，而是选到更小的安全候选 gate
    const p = previewRedirect(g);
    expect(p.status).toBe('FOUND');
    if (p.status !== 'FOUND') return;
    expect(p.candidate).toEqual({ from: 1, action: 'activate', to: 0 });
  });

  it('空陷阱前缀 + 原先不可达：before 为 null，陷阱见证为空序列', () => {
    // B 仅在 s 开时可见；A 激活翻转 s 跳到 C 后无路可走，入口本身即陷阱
    const g = make({
      nodes: ['A', 'B', 'C'],
      switches: ['s'],
      entry: 'A',
      target: 'B',
      conditions: { B: [['s', true]] },
      edges: { A: { activate: { to: 'C', flip: 's' } } },
    });
    expect(trapPrefix(g)!.actions).toEqual([]);
    expect(shortestToTarget(g)).toBeNull();
    const p = previewRedirect(g);
    expect(p.status).toBe('FOUND');
    if (p.status !== 'FOUND') return;
    // A 的激活改到 A 仍到不了 B；改到 B（翻转后 s 开，B 可见）才安全
    expect(p.candidate).toEqual({ from: 0, action: 'activate', to: 1 });
    expect(p.before).toBeNull();
    expect(p.after.actions).toEqual(['activate']);
    expect(p.eliminatedTrap.actions).toEqual([]);
  });

  it('无解：目标永远隐藏且没有任何翻转边 → NO_SINGLE_REDIRECT', () => {
    const g = make({
      nodes: ['A', 'B'],
      switches: ['s'],
      entry: 'A',
      target: 'B',
      conditions: { B: [['s', true]] },
      edges: { A: { tab: 'B' } },
    });
    expect(previewRedirect(g).status).toBe('NO_SINGLE_REDIRECT');
  });

  it('原图无陷阱 → ALREADY_SAFE', () => {
    const g = make({ nodes: ['A', 'B'], entry: 'A', target: 'B', edges: { A: { tab: 'B' } } });
    expect(previewRedirect(g).status).toBe('ALREADY_SAFE');
  });

  it('超出预览上限 → TOO_LARGE；边界仍可运行（导入/搜索上限不变）', () => {
    expect(REDIRECT_MAX_NODES).toBe(12);
    expect(REDIRECT_MAX_SWITCHES).toBe(4);
    const nodes13 = make({
      nodes: Array.from({ length: 13 }, (_, i) => `N${i}`),
      entry: 'N0',
      target: 'N1',
      edges: { N0: { tab: 'N1' } },
    });
    expect(previewRedirect(nodes13).status).toBe('TOO_LARGE');
    const switches5 = make({
      nodes: ['A', 'B'],
      switches: ['a', 'b', 'c', 'd', 'e'],
      entry: 'A',
      target: 'B',
      edges: { A: { tab: 'B' } },
    });
    expect(previewRedirect(switches5).status).toBe('TOO_LARGE');
    // 边界：12 节点 / 4 开关仍可运行
    const edge12 = make({
      nodes: Array.from({ length: 12 }, (_, i) => `N${i}`),
      switches: ['a', 'b', 'c', 'd'],
      entry: 'N0',
      target: 'N1',
      edges: { N0: { tab: 'N1' } },
    });
    expect(previewRedirect(edge12).status).toBe('ALREADY_SAFE');
  });
});

// ---------------------------------------------------------------------------
// 随机小图对拍：独立枚举所有单边替换
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSpec(rnd: () => number): unknown {
  const n = 2 + Math.floor(rnd() * 5); // 2..6 节点
  const s = Math.floor(rnd() * 4); // 0..3 开关
  const nodes = Array.from({ length: n }, (_, i) => `N${i}`);
  const switches = Array.from({ length: s }, (_, i) => `S${i}`);
  const conditions: Record<string, Array<[string, boolean]>> = {};
  for (let i = 0; i < n; i++) {
    if (s === 0 || rnd() < 0.5) continue;
    const lits: Array<[string, boolean]> = [];
    const count = 1 + Math.floor(rnd() * 2);
    for (let k = 0; k < count; k++) {
      const sw = switches[Math.floor(rnd() * s)];
      // 入口节点只允许“关”字面量，保证初始可见
      const value = i === 0 ? false : rnd() < 0.5;
      lits.push([sw, value]);
    }
    conditions[nodes[i]] = lits;
  }
  const edges: Record<string, Record<string, unknown>> = {};
  for (const node of nodes) {
    const e: Record<string, unknown> = {};
    for (const a of ACTION_ORDER) {
      if (rnd() < 0.45) continue;
      const to = nodes[Math.floor(rnd() * n)];
      if (a === 'activate' && s > 0 && rnd() < 0.5) {
        e[a] = { to, flip: switches[Math.floor(rnd() * s)] };
      } else {
        e[a] = to;
      }
    }
    if (Object.keys(e).length > 0) edges[node] = e;
  }
  return { nodes, switches, entry: nodes[0], target: nodes[1], conditions, edges };
}

describe('单边重定向预览 · 与独立枚举对拍（随机小图）', () => {
  for (let seed = 1; seed <= 200; seed++) {
    it(`种子 ${seed}`, () => {
      const g = make(randomSpec(mulberry32(seed)));
      const edgesBefore = JSON.stringify(g.edges);

      // 每个单边替换的安全判定逐一与独立实现比对
      for (const c of allCandidates(g)) {
        const mainSafe = trapPrefix(applyRedirect(g, c)) === null;
        expect(mainSafe).toBe(refSafe(refModify(g, c)));
      }

      // 预览结果整体对拍
      const got = previewRedirect(g);
      const want = refPreview(g);
      expect(got.status).toBe(want.status);
      if (want.status === 'FOUND' && got.status === 'FOUND') {
        expect(got.candidate).toEqual(want.candidate);
        expect(got.before ? got.before.actions : null).toEqual(want.before);
        expect(got.after.actions).toEqual(want.after);
        expect(got.eliminatedTrap.actions).toEqual(want.eliminatedTrap);
        // after 见证可在修改后的图上重放到目标
        const g2 = applyRedirect(g, got.candidate);
        let cur = startState(g2);
        got.after.actions.forEach((a, i) => {
          cur = nextState(g2, cur, a)!;
          expect(cur).toBe(got.after.states[i + 1]);
        });
        expect(Math.floor(cur / (1 << g2.switches.length))).toBe(g2.target);
        // 翻转开关保留
        const orig = g.edges[got.candidate.from][got.candidate.action]!;
        expect(g2.edges[got.candidate.from][got.candidate.action]!.flip).toBe(orig.flip);
      }

      // 纯预览：原图不被修改
      expect(JSON.stringify(g.edges)).toBe(edgesBefore);
    });
  }
});

// ---------------------------------------------------------------------------
// graphToJson 往返
// ---------------------------------------------------------------------------

describe('graphToJson 往返', () => {
  it('内置示例与随机图序列化后解析回原图', () => {
    const graphs = [make(SAMPLE_TEXT)];
    for (let seed = 1; seed <= 20; seed++) graphs.push(make(randomSpec(mulberry32(seed))));
    for (const g of graphs) {
      const r = parseGraph(graphToJson(g));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.graph).toEqual(g);
    }
  });
});
