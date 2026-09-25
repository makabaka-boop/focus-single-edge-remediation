/**
 * 焦点流程图的数据模型与导入校验。
 *
 * 导入格式（JSON）：
 * {
 *   "nodes":    ["gate", "hall", ...],          // 2..40 个唯一节点
 *   "switches": ["lamp", ...],                  // 0..8 个布尔开关，初始全为关
 *   "entry":    "gate",                         // 唯一入口
 *   "target":   "vault",                        // 唯一目标
 *   "conditions": { "vault": [["lamp", false]] },// 每节点可见条件：若干 [开关, 期望值] 的合取
 *   "edges": {
 *     "hall": {
 *       "tab": "vault",                          // Tab 目标（节点名）
 *       "shiftTab": "gate",                      // Shift+Tab 目标（节点名）
 *       "activate": { "to": "cell", "flip": "lamp" } // 激活目标，可顺带翻转一个开关
 *     }
 *   }
 * }
 */

export type ActionKind = 'tab' | 'shiftTab' | 'activate';

/** 同长度路径的裁决顺序：Tab < Shift+Tab < 激活 */
export const ACTION_ORDER: readonly ActionKind[] = ['tab', 'shiftTab', 'activate'];

/** 可见条件字面量：要求开关 sw 的当前值等于 value */
export interface Literal {
  sw: number;
  value: boolean;
}

export interface Edge {
  to: number;
  /** 仅激活动作可携带：翻转的开关下标；null 表示不翻转 */
  flip: number | null;
}

export interface NodeEdges {
  tab: Edge | null;
  shiftTab: Edge | null;
  activate: Edge | null;
}

export interface FocusGraph {
  nodes: string[];
  switches: string[];
  entry: number;
  target: number;
  /** 每节点的可见条件（字面量合取，空数组 = 总是可见） */
  conditions: Literal[][];
  edges: NodeEdges[];
}

export type ParseResult = { ok: true; graph: FocusGraph } | { ok: false; errors: string[] };

/** 节点在给定开关位集下是否可见 */
export function visible(g: FocusGraph, node: number, bits: number): boolean {
  for (const lit of g.conditions[node]) {
    if ((((bits >> lit.sw) & 1) === 1) !== lit.value) return false;
  }
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 解析并校验导入内容（JSON 字符串或已解析的对象）。
 * 失败时返回全部错误，绝不抛出、绝不产生部分图。
 */
export function parseGraph(input: unknown): ParseResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      return { ok: false, errors: [`JSON 解析失败：${(e as Error).message}`] };
    }
  }
  if (!isPlainObject(raw)) return { ok: false, errors: ['导入内容必须是一个 JSON 对象'] };

  const errors: string[] = [];

  // ---- nodes ----
  let nodes: string[] = [];
  if (!Array.isArray(raw.nodes)) {
    errors.push('nodes 必须是字符串数组');
  } else {
    if (raw.nodes.some((n) => typeof n !== 'string' || n.trim() === '')) {
      errors.push('nodes 中不允许出现非字符串或空名称');
    }
    nodes = raw.nodes.filter((n): n is string => typeof n === 'string');
    const seen = new Set<string>();
    for (const n of nodes) {
      if (seen.has(n)) errors.push(`节点名重复：${n}`);
      seen.add(n);
    }
    if (nodes.length < 2 || nodes.length > 40) {
      errors.push(`节点数量必须在 2..40 之间，当前为 ${nodes.length}`);
    }
  }
  const nodeIdx = new Map(nodes.map((n, i) => [n, i]));

  // ---- switches ----
  let switches: string[] = [];
  if (raw.switches !== undefined) {
    if (!Array.isArray(raw.switches)) {
      errors.push('switches 必须是字符串数组');
    } else {
      if (raw.switches.some((s) => typeof s !== 'string' || s.trim() === '')) {
        errors.push('switches 中不允许出现非字符串或空名称');
      }
      switches = raw.switches.filter((s): s is string => typeof s === 'string');
      const seen = new Set<string>();
      for (const s of switches) {
        if (seen.has(s)) errors.push(`开关名重复：${s}`);
        seen.add(s);
      }
      if (switches.length > 8) {
        errors.push(`开关数量最多 8 个，当前为 ${switches.length}`);
      }
    }
  }
  const swIdx = new Map(switches.map((s, i) => [s, i]));

  // ---- entry / target ----
  let entry = -1;
  let target = -1;
  if (typeof raw.entry !== 'string') {
    errors.push('entry 必须是节点名字符串');
  } else {
    const i = nodeIdx.get(raw.entry);
    if (i === undefined) errors.push(`entry 引用了未知节点：${raw.entry}`);
    else entry = i;
  }
  if (typeof raw.target !== 'string') {
    errors.push('target 必须是节点名字符串');
  } else {
    const i = nodeIdx.get(raw.target);
    if (i === undefined) errors.push(`target 引用了未知节点：${raw.target}`);
    else target = i;
  }
  if (entry !== -1 && target !== -1 && entry === target) {
    errors.push('entry 与 target 必须是不同的节点');
  }

  // ---- conditions ----
  const conditions: Literal[][] = nodes.map(() => []);
  if (raw.conditions !== undefined) {
    if (!isPlainObject(raw.conditions)) {
      errors.push('conditions 必须是对象：{ 节点名: [[开关名, 布尔值], ...] }');
    } else {
      for (const [name, cond] of Object.entries(raw.conditions)) {
        const ni = nodeIdx.get(name);
        if (ni === undefined) {
          errors.push(`conditions 引用了未知节点：${name}`);
          continue;
        }
        if (!Array.isArray(cond)) {
          errors.push(`节点 ${name} 的可见条件必须是字面量数组`);
          continue;
        }
        for (const lit of cond) {
          if (
            !Array.isArray(lit) ||
            lit.length !== 2 ||
            typeof lit[0] !== 'string' ||
            typeof lit[1] !== 'boolean'
          ) {
            errors.push(`节点 ${name} 的条件字面量必须是 [开关名, 布尔值] 二元组`);
            continue;
          }
          const si = swIdx.get(lit[0]);
          if (si === undefined) {
            errors.push(`节点 ${name} 的条件引用了未知开关：${lit[0]}`);
            continue;
          }
          conditions[ni].push({ sw: si, value: lit[1] });
        }
      }
    }
  }

  // ---- edges ----
  const edges: NodeEdges[] = nodes.map(() => ({ tab: null, shiftTab: null, activate: null }));

  const parseTargetName = (v: unknown, owner: string, action: string): number | null => {
    if (typeof v !== 'string') {
      errors.push(`节点 ${owner} 的 ${action} 目标必须是节点名字符串`);
      return null;
    }
    const ti = nodeIdx.get(v);
    if (ti === undefined) {
      errors.push(`节点 ${owner} 的 ${action} 目标指向未知节点：${v}`);
      return null;
    }
    return ti;
  };

  if (raw.edges !== undefined) {
    if (!isPlainObject(raw.edges)) {
      errors.push('edges 必须是对象：{ 节点名: { tab, shiftTab, activate } }');
    } else {
      for (const [name, spec] of Object.entries(raw.edges)) {
        const ni = nodeIdx.get(name);
        if (ni === undefined) {
          errors.push(`edges 引用了未知节点：${name}`);
          continue;
        }
        if (!isPlainObject(spec)) {
          errors.push(`节点 ${name} 的 edges 必须是对象`);
          continue;
        }
        for (const key of Object.keys(spec)) {
          if (!ACTION_ORDER.includes(key as ActionKind)) {
            errors.push(`节点 ${name} 存在未知动作：${key}`);
          }
        }
        for (const action of ['tab', 'shiftTab'] as const) {
          const v = spec[action];
          if (v === undefined || v === null) continue;
          const to = parseTargetName(v, name, action);
          if (to !== null) edges[ni][action] = { to, flip: null };
        }
        const act = spec.activate;
        if (act !== undefined && act !== null) {
          if (typeof act === 'string') {
            const to = parseTargetName(act, name, 'activate');
            if (to !== null) edges[ni].activate = { to, flip: null };
          } else if (isPlainObject(act)) {
            const to = parseTargetName(act.to, name, 'activate');
            let flip: number | null = null;
            if (act.flip !== undefined && act.flip !== null) {
              if (typeof act.flip !== 'string' || !swIdx.has(act.flip)) {
                errors.push(`节点 ${name} 的 activate.flip 必须是已声明的开关名`);
              } else {
                flip = swIdx.get(act.flip)!;
              }
            }
            if (to !== null) edges[ni].activate = { to, flip };
          } else {
            errors.push(`节点 ${name} 的 activate 必须是节点名或 { "to", "flip"? } 对象`);
          }
        }
      }
    }
  }

  // ---- 入口在初始状态（所有开关关闭）必须可见 ----
  if (entry !== -1) {
    const hiddenAtStart = conditions[entry].some((lit) => lit.value !== false);
    if (hiddenAtStart) errors.push('入口节点在所有开关关闭的初始状态下必须可见');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, graph: { nodes, switches, entry, target, conditions, edges } };
}
