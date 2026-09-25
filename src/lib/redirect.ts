/**
 * 单边重定向预览：只改一条已定义动作的目标节点，能否让所有入口可达状态
 * 重新通向目标？
 *
 * - 仅在 ≤12 节点、≤4 开关的已合法图上运行（导入 40 节点 / 8 开关的上限不变）；
 * - 候选 = （源节点， 动作， 新目标）：把一条已定义的 Tab / Shift+Tab / 激活动作的
 *   目标改为不同于旧目标的另一已声明节点，激活动作原有的翻转开关不变；
 * - 候选安全 ⟺ 改后图中不存在入口可达却无法抵达目标的状态；
 * - 多个安全候选按 （源节点 id, 动作优先级， 目标 id) 取最小。
 *
 * 纯预览：previewRedirect 不修改传入的图；调用方确认后自行用 applyRedirect
 * 生成新图并替换。
 */
import { ACTION_ORDER, type ActionKind, type FocusGraph, type NodeEdges } from './model';
import {
  bitCount,
  goodStates,
  nextState,
  shortestToTarget,
  startState,
  trapPrefix,
  type Witness,
} from './search';

/** 预览上限（区别于导入上限 40 节点 / 8 开关） */
export const REDIRECT_MAX_NODES = 12;
export const REDIRECT_MAX_SWITCHES = 4;

/** 一个单边重定向候选：把 from 节点的 action 动作目标改为 to */
export interface RedirectCandidate {
  from: number;
  action: ActionKind;
  to: number;
}

export type RedirectPreview =
  | { status: 'TOO_LARGE' }
  | { status: 'ALREADY_SAFE' }
  | { status: 'NO_SINGLE_REDIRECT' }
  | {
      status: 'FOUND';
      candidate: RedirectCandidate;
      /** 修改前最短到达见证；原先不可达时为 null */
      before: Witness | null;
      /** 修改后最短到达见证 */
      after: Witness;
      /** 被消除的陷阱见证（原图的最短陷阱前缀） */
      eliminatedTrap: Witness;
    };

/**
 * 应用一个候选：返回新图，仅改指定动作的目标节点，翻转开关保留。
 * 原图不被修改。
 */
export function applyRedirect(g: FocusGraph, c: RedirectCandidate): FocusGraph {
  const edges: NodeEdges[] = g.edges.map((ne, i) =>
    i === c.from ? { ...ne, [c.action]: { to: c.to, flip: ne[c.action]!.flip } } : ne,
  );
  return { ...g, edges };
}

/** 改后图中入口可达的每个状态都仍能到达目标？（即不存在任何陷阱状态） */
function allReachableGood(g: FocusGraph): boolean {
  const good = goodStates(g);
  const seen = new Uint8Array(g.nodes.length * bitCount(g));
  const start = startState(g);
  seen[start] = 1;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const s = queue[head];
    if (!good[s]) return false;
    for (const a of ACTION_ORDER) {
      const n = nextState(g, s, a);
      if (n !== null && !seen[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  return true;
}

/**
 * 预览单边重定向（纯函数，不修改 g）：
 * - 图超过预览上限 → TOO_LARGE；
 * - 原图已无陷阱 → ALREADY_SAFE；
 * - 存在安全候选 → FOUND（按 源节点 id、动作优先级、目标 id 取最小）；
 * - 否则 → NO_SINGLE_REDIRECT。
 */
export function previewRedirect(g: FocusGraph): RedirectPreview {
  if (g.nodes.length > REDIRECT_MAX_NODES || g.switches.length > REDIRECT_MAX_SWITCHES) {
    return { status: 'TOO_LARGE' };
  }
  const eliminatedTrap = trapPrefix(g);
  if (eliminatedTrap === null) return { status: 'ALREADY_SAFE' };
  const before = shortestToTarget(g);
  for (let from = 0; from < g.nodes.length; from++) {
    for (const action of ACTION_ORDER) {
      const edge = g.edges[from][action];
      if (edge === null) continue;
      for (let to = 0; to < g.nodes.length; to++) {
        if (to === edge.to) continue;
        const candidate: RedirectCandidate = { from, action, to };
        const g2 = applyRedirect(g, candidate);
        if (!allReachableGood(g2)) continue;
        // 安全候选下入口状态必能到达目标，after 必非空
        return {
          status: 'FOUND',
          candidate,
          before,
          after: shortestToTarget(g2)!,
          eliminatedTrap,
        };
      }
    }
  }
  return { status: 'NO_SINGLE_REDIRECT' };
}
