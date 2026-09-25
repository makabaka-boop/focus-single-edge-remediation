/**
 * 以 (焦点节点, 开关位集) 为状态的按键序列搜索。
 *
 * - shortestToTarget：到目标节点的最短按键序列；
 * - trapPrefix：从入口可达、但执行后目标永不可达的最短按键前缀。
 * 同长度时按 ACTION_ORDER（Tab < Shift+Tab < 激活）裁决。
 */
import { ACTION_ORDER, visible, type ActionKind, type FocusGraph } from './model';

/** 一条按键见证：actions[i] 把 states[i] 带到 states[i+1] */
export interface Witness {
  actions: ActionKind[];
  states: number[];
}

export function bitCount(g: FocusGraph): number {
  return 1 << g.switches.length;
}

export function stateOf(g: FocusGraph, node: number, bits: number): number {
  return node * bitCount(g) + bits;
}

export function nodeOf(g: FocusGraph, state: number): number {
  return Math.floor(state / bitCount(g));
}

export function bitsOf(g: FocusGraph, state: number): number {
  return state % bitCount(g);
}

export function startState(g: FocusGraph): number {
  return stateOf(g, g.entry, 0);
}

/**
 * 执行一个动作后的后继状态；动作不存在、或（翻转后）目标节点隐藏时返回 null。
 * 注意：只检查目标节点的可见性——焦点随动作转移，源节点之后是否隐藏不影响本动作。
 */
export function nextState(g: FocusGraph, state: number, action: ActionKind): number | null {
  const edge = g.edges[nodeOf(g, state)][action];
  if (!edge) return null;
  const bits = bitsOf(g, state);
  const nb = edge.flip === null ? bits : bits ^ (1 << edge.flip);
  if (!visible(g, edge.to, nb)) return null;
  return stateOf(g, edge.to, nb);
}

/** 边已定义但在给定状态下不可走（翻转后目标隐藏）——即“失效边” */
export function isDeadEdge(g: FocusGraph, state: number, action: ActionKind): boolean {
  return g.edges[nodeOf(g, state)][action] !== null && nextState(g, state, action) === null;
}

/**
 * 有序 BFS：按 ACTION_ORDER 展开，首次到达目标状态即返回。
 * 发现顺序即路径的字典序（按动作优先级），因此结果是最短且同长度按
 * Tab < Shift+Tab < 激活 裁决的唯一序列。
 */
function bfsFirst(g: FocusGraph, start: number, isGoal: (s: number) => boolean): Witness | null {
  const total = g.nodes.length * bitCount(g);
  const prev = new Int32Array(total).fill(-1);
  const via: (ActionKind | null)[] = new Array(total).fill(null);
  prev[start] = start;
  if (isGoal(start)) return { actions: [], states: [start] };

  const queue: number[] = [start];
  let head = 0;
  let found = -1;
  while (found === -1 && head < queue.length) {
    const s = queue[head++];
    for (const a of ACTION_ORDER) {
      const n = nextState(g, s, a);
      if (n === null || prev[n] !== -1) continue;
      prev[n] = s;
      via[n] = a;
      if (isGoal(n)) {
        found = n;
        break;
      }
      queue.push(n);
    }
  }
  if (found === -1) return null;

  const actions: ActionKind[] = [];
  const states: number[] = [];
  for (let cur = found; ; cur = prev[cur]) {
    states.push(cur);
    if (cur === start) break;
    actions.push(via[cur]!);
  }
  actions.reverse();
  states.reverse();
  return { actions, states };
}

/** 到目标（任意开关位集下焦点位于目标节点）的最短按键序列；不可达返回 null */
export function shortestToTarget(g: FocusGraph): Witness | null {
  return bfsFirst(g, startState(g), (s) => nodeOf(g, s) === g.target);
}

/**
 * 标记所有“仍能到达目标”的状态（good）。
 * 从全部 (target, bits) 状态出发沿反向边做 BFS。
 */
export function goodStates(g: FocusGraph): Uint8Array {
  const total = g.nodes.length * bitCount(g);
  const preds: number[][] = Array.from({ length: total }, () => []);
  for (let s = 0; s < total; s++) {
    for (const a of ACTION_ORDER) {
      const n = nextState(g, s, a);
      if (n !== null) preds[n].push(s);
    }
  }
  const good = new Uint8Array(total);
  const queue: number[] = [];
  for (let b = 0; b < bitCount(g); b++) {
    const s = stateOf(g, g.target, b);
    if (!good[s]) {
      good[s] = 1;
      queue.push(s);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    for (const p of preds[queue[head]]) {
      if (!good[p]) {
        good[p] = 1;
        queue.push(p);
      }
    }
  }
  return good;
}

/**
 * 最短陷阱前缀：从入口出发，执行完该序列后落入“再也无法到达目标”的状态。
 * 返回空序列表示入口本身就是陷阱；返回 null 表示入口可达的状态都能到达目标。
 */
export function trapPrefix(g: FocusGraph): Witness | null {
  const good = goodStates(g);
  return bfsFirst(g, startState(g), (s) => !good[s]);
}
