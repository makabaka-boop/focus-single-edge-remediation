/**
 * 单边重定向预览：只改一条已定义动作边（Tab / Shift+Tab / 激活）的目标节点，
 * 翻转开关保持不变，检验能否让所有入口可达状态重新通向目标。
 *
 * - 仅在 ≤12 节点、≤4 开关的已合法图上运行（导入与状态搜索本身的上限不变）；
 * - 候选目标必须是不同于旧目标的另一已声明节点；
 * - 对每个候选重新展开焦点×开关状态图，只要仍存在入口可达却无法抵达目标的
 *   状态就淘汰；
 * - 有安全候选时按（源节点 id，动作优先级 ACTION_ORDER，目标 id）取最小，
 *   返回修改前后最短到达见证（原先不可达时为 null）及被消除的陷阱见证；
 * - 原图已无陷阱返回 ALREADY_SAFE；无解返回 NO_SINGLE_REDIRECT。
 *
 * 预览是纯函数：不修改传入的图；确认应用后由调用方用返回的新图替换当前图。
 */
import { ACTION_ORDER, type ActionKind, type FocusGraph } from './model';
import { shortestToTarget, trapPrefix, type Witness } from './search';

/** 单边重定向预览的规模上限（与导入上限 40 节点 / 8 开关相互独立） */
export const REDIRECT_MAX_NODES = 12;
export const REDIRECT_MAX_SWITCHES = 4;

/** 一个单边重定向候选：把 from 节点的 action 边目标由 oldTo 改为 to */
export interface RedirectCandidate {
  from: number;
  action: ActionKind;
  oldTo: number;
  to: number;
}

export type RedirectPreview =
  | { kind: 'TOO_LARGE' }
  | { kind: 'ALREADY_SAFE' }
  | { kind: 'NO_SINGLE_REDIRECT' }
  | {
      kind: 'FOUND';
      candidate: RedirectCandidate;
      /** 修改前最短到达见证（原先不可达时为 null） */
      before: Witness | null;
      /** 修改后最短到达见证（安全候选下必然存在） */
      after: Witness;
      /** 被消除的陷阱见证：原图的最短陷阱前缀 */
      trap: Witness;
      /** 应用候选后的新图；预览阶段不替换当前图，确认应用后才生效 */
      graph: FocusGraph;
    };

/** 当前图是否允许运行单边重定向预览 */
export function redirectAllowed(g: FocusGraph): boolean {
  return g.nodes.length <= REDIRECT_MAX_NODES && g.switches.length <= REDIRECT_MAX_SWITCHES;
}

/**
 * 生成应用候选后的新图；原图不被修改，被改边的翻转开关保持不变。
 */
export function applyCandidate(g: FocusGraph, c: RedirectCandidate): FocusGraph {
  const edges = g.edges.map((ne) => ({ ...ne }));
  const flip = g.edges[c.from][c.action]?.flip ?? null;
  edges[c.from] = { ...edges[c.from], [c.action]: { to: c.to, flip } };
  return { ...g, edges };
}

/**
 * 预览单边重定向。按（源节点 id，动作优先级，目标 id）升序枚举候选，
 * 第一个改后无陷阱的候选即最小安全候选。
 */
export function previewRedirect(g: FocusGraph): RedirectPreview {
  if (!redirectAllowed(g)) return { kind: 'TOO_LARGE' };

  const trap = trapPrefix(g);
  if (trap === null) return { kind: 'ALREADY_SAFE' };

  for (let from = 0; from < g.nodes.length; from++) {
    for (const action of ACTION_ORDER) {
      const edge = g.edges[from][action];
      if (edge === null) continue;
      for (let to = 0; to < g.nodes.length; to++) {
        if (to === edge.to) continue;
        const candidate: RedirectCandidate = { from, action, oldTo: edge.to, to };
        const fixed = applyCandidate(g, candidate);
        // 仍存在入口可达却无法抵达目标的状态 → 淘汰
        if (trapPrefix(fixed) !== null) continue;
        return {
          kind: 'FOUND',
          candidate,
          before: shortestToTarget(g),
          // 安全候选下入口状态必能到达目标，故 after 必非 null
          after: shortestToTarget(fixed)!,
          trap,
          graph: fixed,
        };
      }
    }
  }
  return { kind: 'NO_SINGLE_REDIRECT' };
}
