import { db } from './db.js'
import { now } from './pipeline.js'
import { createWorkOrder } from './workorders.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 常量与口径 =====
// 影响阶段：萌芽 → 扩散 → 爆发 → 衰退 → 平息（自动研判只升不降，衰退/平息须人工研判）
export const PROP_STAGE = { seed: '萌芽', spread: '扩散', outbreak: '爆发', recession: '衰退', calm: '平息' }
export const STAGE_RANK = { seed: 0, spread: 1, outbreak: 2, recession: 3, calm: 4 }
export const NODE_TYPES = { origin: '来源', kol: 'KOL/大V', media: '媒体', official: '官方', user: '普通账号' }
export const EDGE_TYPES = { repost: '转发', quote: '引用', comment: '评论', report: '报道' }

export const REPOST_REACH = 5      // 每次转发的平均扩散触达（演示口径）
const SPREAD_REACH = 10000         // 累计触达 ≥ 1 万：扩散
const OUTBREAK_REACH = 50000       // 累计触达 ≥ 5 万：爆发
const OUTBREAK_NODES = 6           // 且节点 ≥ 6（避免单账号高触达误判爆发）
const SURGE_DELTA = 8000           // 单次新增触达 ≥ 8000：传播激增
const SURGE_EDGE_REPOSTS = 1500    // 或单条转发关系转发量 ≥ 1500
const KEY_REACH = 20000            // 手动添加节点触达 ≥ 2 万自动标记为关键节点候选

// 通知联动钩子在 index.js 注入（避免 prop ↔ notify 模块循环依赖）
let propHooks = { notify: null }
export function bindPropNotify(hooks) { propHooks = { ...propHooks, ...hooks } }

function addLog(graphId, action, detail, operator = '系统') {
  const r = run('INSERT INTO propagation_logs (graph_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
    graphId, action, detail || '', operator || '系统', now())
  return Number(r.lastInsertRowid)
}

// ===== 查询 =====
function decorateGraph(g) {
  return { ...g, stageText: PROP_STAGE[g.stage] || g.stage }
}

export function listGraphs({ stage = '', crisisId = '', topic = '', limit = 100 } = {}) {
  let sql = `SELECT g.*, c.title crisis_title, c.status crisis_status, p.title post_title
    FROM propagation_graphs g
    LEFT JOIN crisis c ON c.id=g.crisis_id
    LEFT JOIN posts p ON p.id=g.post_id WHERE 1=1`
  const args = []
  if (stage) { sql += ' AND g.stage=?'; args.push(stage) }
  if (crisisId) { sql += ' AND g.crisis_id=?'; args.push(+crisisId) }
  if (topic) { sql += ' AND g.topic LIKE ?'; args.push(`%${topic}%`) }
  sql += ' ORDER BY g.id DESC LIMIT ?'
  args.push(Math.min(300, +limit || 100))
  return q(sql, ...args).map(decorateGraph)
}

export function getGraph(id) {
  const g = q1(`SELECT g.*, c.title crisis_title, c.status crisis_status,
      p.title post_title, p.heat post_heat
    FROM propagation_graphs g
    LEFT JOIN crisis c ON c.id=g.crisis_id LEFT JOIN posts p ON p.id=g.post_id WHERE g.id=?`, id)
  if (!g) return null
  const nodes = q(`SELECT n.*, p.title post_title FROM propagation_nodes n
    LEFT JOIN posts p ON p.id=n.post_id WHERE n.graph_id=? ORDER BY n.depth, n.id`, id)
    .map((n) => ({ ...n, typeText: NODE_TYPES[n.node_type] || n.node_type }))
  const edges = q(`SELECT e.*, a.name from_name, b.name to_name, a.node_type from_type, b.node_type to_type
    FROM propagation_edges e
    JOIN propagation_nodes a ON a.id=e.from_node_id
    JOIN propagation_nodes b ON b.id=e.to_node_id
    WHERE e.graph_id=? ORDER BY e.id`, id)
    .map((e) => ({ ...e, edgeText: EDGE_TYPES[e.edge_type] || e.edge_type }))
  const logs = q('SELECT * FROM propagation_logs WHERE graph_id=? ORDER BY id DESC LIMIT 100', id)
  // 来源沉淀：origin 节点 + 首爆帖信息（列表与详情同源）
  const origins = nodes.filter((n) => n.node_type === 'origin')
  return {
    ...decorateGraph(g),
    nodes, edges, logs, origins,
    keyNodes: nodes.filter((n) => n.is_key),
    dict: { stage: PROP_STAGE, nodeType: NODE_TYPES, edgeType: EDGE_TYPES }
  }
}

export function propSummary() {
  const rows = q('SELECT stage, COUNT(*) c FROM propagation_graphs GROUP BY stage')
  const stages = { seed: 0, spread: 0, outbreak: 0, recession: 0, calm: 0 }
  for (const r of rows) stages[r.stage] = r.c
  const total = Object.values(stages).reduce((a, b) => a + b, 0)
  const linked = q1('SELECT COUNT(*) c FROM propagation_graphs WHERE crisis_id IS NOT NULL').c
  const watch = stages.seed + stages.spread + stages.outbreak
  return { stages, total, linked, watch }
}

// ===== 派生量重算：累计触达（节点触达 + 转发扩散）、热度、节点深度（BFS） =====
function recompute(graphId) {
  const nodes = q('SELECT * FROM propagation_nodes WHERE graph_id=?', graphId)
  const edges = q('SELECT * FROM propagation_edges WHERE graph_id=?', graphId)
  // BFS：沿 from→to 从来源节点计算最短传播深度（孤立节点保留原 depth）
  const depth = new Map(nodes.map((n) => [n.id, n.node_type === 'origin' ? 0 : null]))
  let changed = true
  while (changed) {
    changed = false
    for (const e of edges) {
      const d = depth.get(e.from_node_id)
      if (d != null && (depth.get(e.to_node_id) == null || d + 1 < depth.get(e.to_node_id))) {
        depth.set(e.to_node_id, d + 1)
        changed = true
      }
    }
  }
  const updNode = db.prepare('UPDATE propagation_nodes SET depth=? WHERE id=?')
  for (const n of nodes) {
    const d = depth.get(n.id)
    if (d != null && d !== n.depth) updNode.run(d, n.id)
  }
  const nodeReach = nodes.reduce((a, n) => a + (n.reach || 0), 0)
  const edgeReach = edges.reduce((a, e) => a + (e.reposts || 0) * REPOST_REACH, 0)
  const totalReach = nodeReach + edgeReach
  const keyCount = nodes.filter((n) => n.is_key).length
  // 热度随关键节点与触达上升（只升不降，避免后期波动）
  const g = q1('SELECT heat FROM propagation_graphs WHERE id=?', graphId)
  const derived = Math.min(100, 30 + Math.round(totalReach / 2000) + keyCount * 6)
  const heat = Math.max(g?.heat || 0, derived)
  run(`UPDATE propagation_graphs SET total_reach=?, node_count=?, edge_count=?, heat=?, updated=? WHERE id=?`,
    totalReach, nodes.length, edges.length, heat, now(), graphId)
  return q1('SELECT * FROM propagation_graphs WHERE id=?', graphId)
}

// 自动研判阶段（仅在 萌芽/扩散/爆发 之间自动上调；衰退/平息须人工研判）
function autoStage(totalReach, nodeCount) {
  if (totalReach >= OUTBREAK_REACH && nodeCount >= OUTBREAK_NODES) return 'outbreak'
  if (totalReach >= SPREAD_REACH) return 'spread'
  return 'seed'
}

function firePropEvent(graphId, propEvent, { title, content, idemTag }) {
  if (!propHooks.notify) return
  try { propHooks.notify(graphId, propEvent, { title, content, idemTag }) }
  catch (e) { console.error('[PROP] 传播通知失败：', e.message) }
}

// 阶段变化统一入口：落库 + 留痕 + 触发通知（auto 每阶段幂等一次，manual 每次独立幂等）
function applyStage(g, target, { manual = false, note = '', operator = '系统' } = {}) {
  if (target === g.stage) return
  const ts = now()
  run('UPDATE propagation_graphs SET stage=?, updated=? WHERE id=?', target, ts, g.id)
  const how = manual ? '人工研判' : '自动研判'
  const logId = addLog(g.id, '阶段变化',
    `影响阶段变化：${PROP_STAGE[g.stage]} → ${PROP_STAGE[target]}（${how}）${note ? '：' + note : ''}`, operator)
  firePropEvent(g.id, 'stage', {
    title: `【传播阶段】${g.title}`,
    content: `传播路径 #${g.id}「${g.title}」影响阶段 ${PROP_STAGE[g.stage]} → ${PROP_STAGE[target]}` +
      `（${how}）· 累计触达 ${Number(g.total_reach || 0).toLocaleString()} · 节点 ${g.node_count}${note ? ' · ' + note : ''}`,
    idemTag: manual ? `manual:${logId}` : `auto:${target}`
  })
}

// 变化后统一研判：自动阶段升级（衰退/平息期不再自动上调）
function maybeAutoStage(g, opts = {}) {
  if (STAGE_RANK[g.stage] > STAGE_RANK.outbreak) return
  const target = autoStage(g.total_reach, g.node_count)
  if (STAGE_RANK[target] > STAGE_RANK[g.stage]) applyStage(g, target, opts)
}

// ===== 建档（支持直接绑定来源舆情/危机；缺省按话题自动并入未结案危机） =====
export function createGraph(body, actor) {
  const b = body || {}
  const title = String(b.title || '').trim()
  if (!title) return { error: '传播路径标题必填' }
  const topic = String(b.topic || '').trim()
  if (!topic) return { error: '话题必填（与预警/危机同口径归并）' }
  let crisisId = b.crisis_id ? +b.crisis_id : null
  if (crisisId && !q1('SELECT 1 FROM crisis WHERE id=?', crisisId)) return { error: '关联危机事件不存在' }
  // 未显式指定时：同话题未结案事件自动并入（与预警→危机归并口径一致）
  if (!crisisId) {
    const c = q1("SELECT id FROM crisis WHERE topic=? AND status!='closed' ORDER BY id DESC LIMIT 1", topic)
    if (c) crisisId = c.id
  }
  const postId = b.post_id ? +b.post_id : null
  if (postId && !q1('SELECT 1 FROM posts WHERE id=?', postId)) return { error: '来源舆情不存在' }
  const post = postId ? q1('SELECT * FROM posts WHERE id=?', postId) : null
  const ts = now()
  const originText = String(b.origin_text || '').trim()
  const r = run(`INSERT INTO propagation_graphs
    (title,topic,post_id,crisis_id,stage,heat,total_reach,node_count,edge_count,origin_text,created,updated)
    VALUES (?,?,?,?, 'seed',0,0,0,0,?,?,?)`,
    title, topic, postId, crisisId, originText || (post ? `来源帖《${post.title}》` : ''), ts, ts)
  const id = Number(r.lastInsertRowid)
  addLog(id, '建档', `传播路径建档，话题「${topic}」${crisisId ? '，关联危机事件 #' + crisisId : '（暂无关联危机）'}`, actor.user)
  // 来源节点沉淀（首爆帖）
  if (post) {
    const reach = Math.max(500, Math.round((post.heat || 50) * 60))
    run(`INSERT INTO propagation_nodes (graph_id,post_id,name,node_type,channel,reach,depth,is_key,note,created)
      VALUES (?,?,?, 'origin',?,?,0,0,?,?)`,
      id, post.id, String(b.origin_name || '').trim() || post.media || '首爆来源', post.media || '', reach,
      `首爆来源帖（热度${post.heat}，${post.sentiment === 'negative' ? '负面' : post.sentiment}）`, ts)
    recompute(id)
    addLog(id, '来源沉淀', `沉淀来源节点：${post.media || '首爆来源'}《${post.title}》，初始触达约 ${reach.toLocaleString()}`, actor.user)
  }
  const g = recompute(id)
  maybeAutoStage(g)
  return { ok: true, id }
}

// ===== 沉淀节点（KOL/媒体/官方/普通账号；大触达自动标记关键节点并触发通知） =====
export function addNode(graphId, body, actor) {
  const g = q1('SELECT * FROM propagation_graphs WHERE id=?', graphId)
  if (!g) return null
  const b = body || {}
  const name = String(b.name || '').trim()
  if (!name) return { error: '节点名称必填（账号/媒体名）' }
  const type = NODE_TYPES[b.node_type] ? b.node_type : 'user'
  const reach = Math.max(0, Math.min(100000000, +b.reach || 0))
  const postId = b.post_id ? +b.post_id : null
  if (postId && !q1('SELECT 1 FROM posts WHERE id=?', postId)) return { error: '关联舆情不存在' }
  const autoKey = reach >= KEY_REACH && ['kol', 'media', 'official'].includes(type)
  const isKey = b.is_key ? 1 : autoKey ? 1 : 0
  const before = { reach: g.total_reach, stage: g.stage }
  const ts = now()
  const nr = run(`INSERT INTO propagation_nodes (graph_id,post_id,name,node_type,channel,reach,depth,is_key,note,created)
    VALUES (?,?,?,?,?,?,0,?,?,?)`,
    graphId, postId || null, name, type, String(b.channel || '').trim(), reach, isKey, String(b.note || '').trim(), ts)
  const nodeId = Number(nr.lastInsertRowid)
  addLog(graphId, '节点沉淀',
    `新增传播节点：${NODE_TYPES[type]}「${name}」（${b.channel || '未知渠道'}，触达 ${reach.toLocaleString()}）${isKey ? ' ⭐关键节点' : ''}`,
    actor.user)
  const ng = recompute(graphId)
  const delta = ng.total_reach - before.reach
  if (isKey) {
    firePropEvent(graphId, 'keynode', {
      title: `【关键节点】${g.title}`,
      content: `传播路径 #${graphId} 出现关键节点：${NODE_TYPES[type]}「${name}」（${b.channel || '未知渠道'}，触达 ${reach.toLocaleString()}）· 当前累计触达 ${ng.total_reach.toLocaleString()}`,
      idemTag: `node:${nodeId}`
    })
  }
  // 传播激增：单次新增触达超阈值
  if (delta >= SURGE_DELTA) {
    addLog(graphId, '传播激增', `新增节点「${name}」带来触达增量 ${delta.toLocaleString()}，判定为传播激增`, actor.user)
    firePropEvent(graphId, 'surge', {
      title: `【传播激增】${g.title}`,
      content: `传播路径 #${graphId} 监测到传播激增：节点「${name}」新增触达约 ${delta.toLocaleString()}，累计触达 ${ng.total_reach.toLocaleString()}，请尽快研判处置`,
      idemTag: `node:${nodeId}`
    })
  }
  maybeAutoStage(ng, { note: `新增节点「${name}」驱动研判`, operator: actor.user })
  return { ok: true, nodeId, deltaReach: delta }
}

// ===== 沉淀转发关系（from 转发/引用/报道 to） =====
export function addEdge(graphId, body, actor) {
  const g = q1('SELECT * FROM propagation_graphs WHERE id=?', graphId)
  if (!g) return null
  const b = body || {}
  const fromId = +b.from_node_id, toId = +b.to_node_id
  if (!fromId || !toId) return { error: '请选择上下游节点' }
  if (fromId === toId) return { error: '不能建立自环转发关系' }
  const from = q1('SELECT * FROM propagation_nodes WHERE id=? AND graph_id=?', fromId, graphId)
  const to = q1('SELECT * FROM propagation_nodes WHERE id=? AND graph_id=?', toId, graphId)
  if (!from || !to) return { error: '节点不存在或不属于该传播路径' }
  const edgeType = EDGE_TYPES[b.edge_type] ? b.edge_type : 'repost'
  const reposts = Math.max(0, Math.min(100000000, +b.reposts || 0))
  // 完全相同的关系不重复沉淀（同一关系后续可再添加形成新波次）
  const dup = q1('SELECT 1 FROM propagation_edges WHERE graph_id=? AND from_node_id=? AND to_node_id=? AND edge_type=? AND reposts=?',
    graphId, fromId, toId, edgeType, reposts)
  if (dup) return { error: '相同转发关系已沉淀（调整转发量或关系类型后重试）' }
  const before = { reach: g.total_reach, stage: g.stage }
  const er = run(`INSERT INTO propagation_edges (graph_id,from_node_id,to_node_id,edge_type,reposts,note,created)
    VALUES (?,?,?,?,?,?,?)`, graphId, fromId, toId, edgeType, reposts, String(b.note || '').trim(), now())
  const edgeId = Number(er.lastInsertRowid)
  addLog(graphId, '转发关系', `新增转发关系：「${from.name}」${EDGE_TYPES[edgeType]}→「${to.name}」（转发 ${reposts.toLocaleString()}，扩散触达约 ${(reposts * REPOST_REACH).toLocaleString()}）`, actor.user)
  const ng = recompute(graphId)
  const delta = ng.total_reach - before.reach
  if (reposts >= SURGE_EDGE_REPOSTS || delta >= SURGE_DELTA) {
    addLog(graphId, '传播激增', `转发关系「${from.name}→${to.name}」形成扩散增量 ${delta.toLocaleString()}，判定为传播激增`, actor.user)
    firePropEvent(graphId, 'surge', {
      title: `【传播激增】${g.title}`,
      content: `传播路径 #${graphId} 监测到传播激增：「${from.name}」${EDGE_TYPES[edgeType]}「${to.name}」（转发 ${reposts.toLocaleString()}），新增触达约 ${delta.toLocaleString()}，累计 ${ng.total_reach.toLocaleString()}`,
      idemTag: `edge:${edgeId}`
    })
  }
  maybeAutoStage(ng, { note: `新增转发关系「${from.name}→${to.name}」驱动研判`, operator: actor.user })
  return { ok: true, edgeId, deltaReach: delta }
}

// ===== 人工研判影响阶段（含衰退/平息；阶段每次变化独立通知） =====
export function setStage(graphId, body, actor) {
  const g = q1('SELECT * FROM propagation_graphs WHERE id=?', graphId)
  if (!g) return null
  const target = String(body?.stage || '')
  if (!PROP_STAGE[target]) return { error: '影响阶段无效' }
  if (target === g.stage) return { error: `当前已是「${PROP_STAGE[target]}」阶段` }
  const note = String(body?.note || '').trim()
  applyStage(g, target, { manual: true, note, operator: actor.user })
  return { ok: true, stage: target }
}

// ===== 关联/解绑危机事件（预警与危机闭环联动） =====
export function bindCrisis(graphId, crisisId, body, actor) {
  const g = q1('SELECT * FROM propagation_graphs WHERE id=?', graphId)
  if (!g) return null
  const cid = crisisId === null || crisisId === '' || crisisId === 0 ? null : +crisisId
  if (cid && !q1('SELECT 1 FROM crisis WHERE id=?', cid)) return { error: '危机事件不存在' }
  if (cid === (g.crisis_id ?? null)) return { error: cid ? '该路径已关联此危机事件' : '该路径当前未关联危机事件' }
  run('UPDATE propagation_graphs SET crisis_id=?, updated=? WHERE id=?', cid, now(), graphId)
  if (cid) {
    const c = q1('SELECT title FROM crisis WHERE id=?', cid)
    addLog(graphId, '关联危机', `人工关联危机事件 #${cid}「${c.title}」，纳入危机处置闭环：${String(body?.note || '').trim() || '同话题联动'}`, actor.user)
  } else {
    addLog(graphId, '解除关联', `解除与危机事件 #${g.crisis_id} 的关联：${String(body?.note || '').trim()}`, actor.user)
  }
  return { ok: true, crisisId: cid }
}

// 预警触发 → 关联到同话题既有传播路径（任意级别；幂等：同一触发记录只关联一次）
// 守卫：同话题但已归属另一危机（本触发未归属该危机）时不串绑，避免一条舆情命中多规则时错关联
export function attachAlertEvent(eventId, { silent = false } = {}) {
  const ev = q1(`SELECT ae.*, p.topic ptopic, p.title ptitle, p.heat pheat, al.level alevel, al.title atitle
    FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN alerts al ON al.id=ae.alert_id
    WHERE ae.id=?`, eventId)
  if (!ev || !ev.ptopic) return null
  const g = q1("SELECT * FROM propagation_graphs WHERE topic=? ORDER BY id DESC LIMIT 1", ev.ptopic)
  if (!g) return null
  if (g.crisis_id && ev.crisis_id && g.crisis_id !== ev.crisis_id) return g // 归属不同危机事件：仅不串绑
  // 已关联同一触发记录则幂等跳过（以日志判定，避免多列冗余）
  if (q1('SELECT 1 FROM propagation_logs WHERE graph_id=? AND action=? AND detail LIKE ? LIMIT 1',
    g.id, '关联预警', `%#${eventId}%`)) return g
  const heat = Math.max(g.heat, ev.pheat || 0)
  run('UPDATE propagation_graphs SET heat=?, updated=? WHERE id=?', heat, now(), g.id)
  addLog(g.id, '关联预警', `关联预警触发记录 #${eventId}（规则「${ev.atitle || '已删除'}」·${ev.pheat ? ' 热度' + ev.pheat : ''}），来源舆情《${ev.ptitle || '—'}》`, '预警管线')
  if (!silent) {
    const ng = q1('SELECT * FROM propagation_graphs WHERE id=?', g.id)
    maybeAutoStage(ng, { note: '预警触发联动研判' })
  }
  return q1('SELECT * FROM propagation_graphs WHERE id=?', g.id)
}

// 红/橙预警触发 → 无同话题路径时自动建档并沉淀来源节点；有则仅关联
export function ensureGraphForAlertEvent(eventId) {
  const ev = q1(`SELECT ae.*, p.topic ptopic, p.title ptitle, p.heat pheat, p.media pmedia, p.sentiment,
      al.level alevel, al.title atitle
    FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN alerts al ON al.id=ae.alert_id
    WHERE ae.id=?`, eventId)
  if (!ev || !ev.ptopic) return null
  // 同话题已有路径：归属同一危机（或双方都无危机）才并入；归属不同危机则各建各的，不串绑
  const sameTopic = q1("SELECT * FROM propagation_graphs WHERE topic=? ORDER BY id DESC LIMIT 1", ev.ptopic)
  if (sameTopic && (!sameTopic.crisis_id || !ev.crisis_id || sameTopic.crisis_id === ev.crisis_id)) {
    return attachAlertEvent(eventId, { silent: true })
  }
  if (!['red', 'orange'].includes(ev.alevel)) return null
  // 注意：预警触发建档不做按话题隐式并危机——只绑定本条预警触发自身归属的危机
  // （一条舆情可能命中多条不同归并话题的规则，隐式并话题会错关联到其他事件）
  const reach = Math.max(500, Math.round((ev.pheat || 60) * 60))
  const ts = now()
  const crisisId = ev.crisis_id || null
  const r = run(`INSERT INTO propagation_graphs
    (title,topic,post_id,alert_event_id,crisis_id,stage,heat,total_reach,node_count,edge_count,origin_text,created,updated)
    VALUES (?,?,?,?,?, 'seed',?,?,1,0,?,?,?)`,
    `${ev.ptopic}传播路径`, ev.ptopic, ev.post_id, eventId, crisisId,
    ev.pheat || 60, reach, `首爆来源帖《${ev.ptitle || '—'}》（${ev.pmedia || '未知渠道'}）`, ts, ts)
  const id = Number(r.lastInsertRowid)
  run(`INSERT INTO propagation_nodes (graph_id,post_id,name,node_type,channel,reach,depth,is_key,note,created)
    VALUES (?,?,?, 'origin',?,?,0,0,?,?)`,
    id, ev.post_id, ev.pmedia || '首爆来源', ev.pmedia || '', reach,
    `${ev.alevel === 'red' ? '红色' : '橙色'}预警触发自动建档：${ev.atitle} · 热度${ev.pheat}`, ts)
  addLog(id, '建档', `${ev.alevel === 'red' ? '红色' : '橙色'}预警「${ev.atitle}」触发，自动建立传播路径（话题「${ev.ptopic}」）`, '预警管线')
  addLog(id, '来源沉淀', `沉淀来源节点：${ev.pmedia || '首爆来源'}《${ev.ptitle || '—'}》，初始触达约 ${reach.toLocaleString()}`, '预警管线')
  addLog(id, '关联预警', `关联预警触发记录 #${eventId}（规则「${ev.atitle}」），来源舆情《${ev.ptitle || '—'}》`, '预警管线')
  if (crisisId) addLog(id, '关联危机', `预警自动建档危机事件 #${crisisId}，传播路径同步纳入处置闭环`, '预警管线')
  const g = recompute(id)
  maybeAutoStage(g, { note: '预警建档初始研判', operator: '预警管线' })
  return g
}

// ===== 跨角色处置工单：按影响阶段一键生成多团队工单（复用工单状态机/SLA/通知/结案守卫） =====
const WO_TPL = {
  seed: [
    { category: 'ops', role: 'ops', priority: 'normal', sla: 120, title: '盯守传播源头与扩散动向',
      detail: '盯守首爆账号与转述节点，每 30 分钟回传新增节点/转发量与情感变化，发现升温立即升级。' }
  ],
  spread: [
    { category: 'pr', role: 'pr', priority: 'high', sla: 60, title: '准备统一回应口径',
      detail: '梳理传播链关键节点与核心质疑，准备首份回应口径与媒体 Q&A，待命发布。' },
    { category: 'ops', role: 'ops', priority: 'high', sla: 90, title: '核查传播源头事实',
      detail: '核实首爆内容真实性与涉事主体，固定原始链接/截图，形成事实核查简报。' },
    { category: 'support', role: 'support', priority: 'normal', sla: 120, title: '客诉通道集中受理',
      detail: '汇总各渠道相关咨询与投诉，统一答复话术，登记台账并同步处置组。' }
  ],
  outbreak: [
    { category: 'pr', role: 'pr', priority: 'urgent', sla: 30, title: '发布官方声明并对接头部媒体',
      detail: '2 小时内发布官方声明，对接关键媒体/KOL 节点，持续发布处置进展，压制谣言扩散。' },
    { category: 'legal', role: 'legal', priority: 'urgent', sla: 60, title: '证据固定与合规评估',
      detail: '固定首爆与高转发内容证据，评估法律责任与追责口径，审核对外声明合规性。' },
    { category: 'ops', role: 'ops', priority: 'urgent', sla: 60, title: '现场处置与整改落地',
      detail: '对涉事环节立即整改/关停，组织现场核查并拍照留档，整改结果实时回传。' },
    { category: 'support', role: 'support', priority: 'high', sla: 90, title: '受影响用户安抚与补偿',
      detail: '制定用户安抚与补偿方案，客服全员上线集中回访，退款/补偿进度同步台账。' },
    { category: 'other', role: 'admin', priority: 'high', sla: 60, title: '跨部门协调与处置例会',
      detail: '协调组牵头每小时同步处置进展，统筹公关/法务/运营/客服动作，向上汇报。' }
  ],
  recession: [
    { category: 'pr', role: 'pr', priority: 'normal', sla: 240, title: '长尾舆情跟踪与口碑修复',
      detail: '跟踪转述回落与搜索指数，安排正面内容投放与口碑修复，防止次生舆情。' },
    { category: 'support', role: 'support', priority: 'normal', sla: 240, title: '遗留客诉清零',
      detail: '对未闭环客诉逐一回访清零，输出补偿落实情况报告。' }
  ],
  calm: [
    { category: 'ops', role: 'ops', priority: 'normal', sla: 480, title: '传播复盘与结案归档',
      detail: '汇总传播路径、节点与处置动作，输出复盘报告并归档，提炼监测规则优化建议。' }
  ]
}

export function dispatchWorkOrders(graphId, body, actor) {
  const g = q1('SELECT * FROM propagation_graphs WHERE id=?', graphId)
  if (!g) return null
  if (!g.crisis_id) return { error: '该传播路径尚未关联危机事件，请先关联（或选择同话题未结案事件）' }
  const c = q1('SELECT status FROM crisis WHERE id=?', g.crisis_id)
  if (!c) return { error: '关联危机事件不存在' }
  if (c.status === 'closed') return { error: '关联危机事件已结案，不能再生成工单（如需协同请先回滚结案）' }
  const override = body && typeof body === 'object' ? body : {}
  const pickCats = Array.isArray(override.categories) && override.categories.length ? override.categories : null
  const tpl = (WO_TPL[g.stage] || WO_TPL.seed).filter((t) => !pickCats || pickCats.includes(t.category))
  if (!tpl.length) return { error: '所选团队没有对应阶段的工单模板' }
  const ids = []
  db.exec('BEGIN')
  try {
    for (const t of tpl) {
      const assignee = (override.assignees && override.assignees[t.category]) || ''
      const r = createWorkOrder({
        crisis_id: g.crisis_id,
        title: `【${PROP_STAGE[g.stage]}·传播处置】${t.title}`,
        detail: `${t.detail}\n来源：传播路径 #${graphId}「${g.title}」（累计触达 ${g.total_reach.toLocaleString()}，节点 ${g.node_count}）`,
        category: t.category, priority: t.priority, assignee_role: t.role, assignee,
        sla_min: override.sla_min ?? t.sla,
        prop_graph_id: graphId
      }, actor)
      if (r.error) throw new Error(r.error)
      ids.push(r.id)
      addLog(graphId, '工单生成', `按「${PROP_STAGE[g.stage]}」阶段生成跨角色处置工单 #${r.id}（${t.title}）→ ${assignee || '待分派'}`, actor.user)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    return { error: String(e.message || e) }
  }
  return { ok: true, ids, stage: g.stage, crisisId: g.crisis_id }
}

export function deleteGraph(id) {
  const g = q1('SELECT 1 FROM propagation_graphs WHERE id=?', id)
  if (!g) return false
  run('DELETE FROM propagation_logs WHERE graph_id=?', id)
  run('DELETE FROM propagation_edges WHERE graph_id=?', id)
  run('DELETE FROM propagation_nodes WHERE graph_id=?', id)
  run('DELETE FROM propagation_graphs WHERE id=?', id)
  return true
}
