<template>
  <div class="prop">
    <div class="toolbar">
      <button v-if="isAdmin" class="add" @click="showCreate=!showCreate">＋ 新建传播路径</button>
      <div class="chips">
        <button class="chip" :class="{on:!filter.stage}" @click="setStage('')">全部 {{ summary.total||0 }}</button>
        <button v-for="(txt,k) in dict.stage" :key="k" class="chip" :class="[k,{on:filter.stage===k}]" @click="setStage(k)">
          {{ txt }} {{ summary.stages?.[k]||0 }}
        </button>
        <span v-if="summary.linked" class="chip linked">🔗 关联危机 {{ summary.linked }}</span>
      </div>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>
    <p class="hint">🕸️ 沉淀来源、传播节点与转发关系，自动研判影响阶段（萌芽→扩散→爆发；衰退/平息人工研判）；红/橙预警自动建档并关联预警与危机事件；阶段变化/关键节点/传播激增按订阅触发通知，并可一键生成跨角色处置工单。</p>

    <!-- 新建传播路径 -->
    <form v-if="showCreate" class="p-form" @submit.prevent="create">
      <div class="row">
        <input v-model="form.title" placeholder="路径标题，如 某品牌后厨卫生风波" required />
        <input v-model="form.topic" list="prop-topics" placeholder="归并话题（如 食品安全）" required />
        <datalist id="prop-topics"><option v-for="t in topics" :key="t" :value="t" /></datalist>
      </div>
      <div class="row">
        <select v-model.number="form.post_id">
          <option :value="null">选择首爆来源帖（可选）</option>
          <option v-for="p in posts" :key="p.id" :value="p.id">#{{ p.id }} {{ p.title }}（{{ p.topic }}·热度{{ p.heat }}）</option>
        </select>
        <select v-model.number="form.crisis_id">
          <option :value="null">关联危机（留空=按话题自动并入未结案事件）</option>
          <option v-for="c in openCrises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}</option>
        </select>
        <input v-model="form.origin_name" placeholder="来源账号/媒体名（选填，默认取来源媒体）" />
      </div>
      <input v-model="form.origin_text" placeholder="来源沉淀描述（选填，如 论坛 @某某 首爆暗访视频 02:10）" />
      <div class="row">
        <button class="save" type="submit">建档并沉淀来源</button>
        <button type="button" class="ghost" @click="showCreate=false">取消</button>
      </div>
    </form>

    <div v-if="!items.length" class="none">暂无传播路径（红/橙预警触发时自动建档，或点击右上角新建）</div>

    <div class="glist">
      <div v-for="g in items" :key="g.id" class="gcard" :class="g.stage">
        <div class="g-head">
          <span class="stage-tag" :class="g.stage">{{ g.stageText }}</span>
          <b class="g-title">{{ g.title }}</b>
          <span class="g-topic">#{{ g.topic }}</span>
          <span v-if="g.crisis_id" class="g-crisis">🛟 危机 #{{ g.crisis_id }} {{ g.crisis_title }}</span>
          <span v-else class="g-crisis none-link">未关联危机</span>
          <button v-if="isAdmin" class="del" @click="remove(g)">✕</button>
        </div>
        <div class="g-meta">
          <span>🌡 热度 <i>{{ g.heat }}</i></span>
          <span>👥 累计触达 <i>{{ fmt(g.total_reach) }}</i></span>
          <span>🕸 节点 <i>{{ g.node_count }}</i></span>
          <span>🔀 转发关系 <i>{{ g.edge_count }}</i></span>
          <span v-if="g.post_id">📰 来源帖 <i>《{{ g.post_title }}》</i></span>
          <span>更新 <i>{{ g.updated }}</i></span>
        </div>
        <div class="g-origin">📍 来源：{{ g.origin_text || '—' }}</div>

        <!-- ===== 详情展开 ===== -->
        <div v-if="detailId===g.id && detail" class="g-detail">
          <div class="graph-wrap">
            <svg :viewBox="`0 0 ${svgW} ${svgH(detail)}`" class="graph">
              <defs>
                <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="#5b7bb0"/>
                </marker>
              </defs>
              <g v-for="e in detail.edges" :key="e.id">
                <path :d="edgePath(e, detail)" fill="none" :stroke="e.edge_type==='report' ? '#7e57c2' : '#5b7bb0'"
                  :stroke-width="Math.min(4, 1 + Math.log10(1 + e.reposts) * 0.9)" :marker-end="'url(#arrow)'"
                  class="edge-line"/>
                <text v-if="e.reposts>=200" :x="(nodePos(e.from_node_id,detail).x+nodePos(e.to_node_id,detail).x)/2"
                  :y="(nodePos(e.from_node_id,detail).y+nodePos(e.to_node_id,detail).y)/2-4"
                  class="edge-label">{{ fmt(e.reposts) }}转</text>
              </g>
              <g v-for="n in detail.nodes" :key="n.id" :transform="`translate(${nodePos(n.id,detail).x},${nodePos(n.id,detail).y})`">
                <circle r="22" :class="['gnode', n.node_type, {key:n.is_key}]" />
                <text y="3" text-anchor="middle" class="gnode-ico">{{ nodeIcon(n.node_type) }}</text>
                <text y="38" text-anchor="middle" class="gnode-name">{{ short(n.name, 8) }}</text>
                <text y="50" text-anchor="middle" class="gnode-sub">{{ n.channel }} · {{ fmt(n.reach) }}</text>
              </g>
            </svg>
          </div>

          <!-- 操作区 -->
          <div class="g-actions" v-if="canOps">
            <button class="op addn" @click="openNode(g)">＋ 沉淀节点</button>
            <button class="op adde" :disabled="detail.nodes.length<2" @click="openEdge(g)">🔀 沉淀转发</button>
            <button class="op stage" @click="changeStage(g)">🧭 研判阶段</button>
            <button class="op bind" @click="openBind(g)">🔗 {{ g.crisis_id ? '改绑危机' : '关联危机' }}</button>
            <button class="op dispatch" @click="dispatch(g)">📋 生成处置工单</button>
            <button class="op jump" @click="goWork">→ 工单看板</button>
          </div>

          <!-- 节点表单 -->
          <form v-if="nodeFormFor===g.id" class="mini-form" @submit.prevent="submitNode(g)">
            <div class="row">
              <input v-model="nodeForm.name" placeholder="账号/媒体名称，如 @热点围观" required />
              <select v-model="nodeForm.node_type">
                <option v-for="(t,k) in dict.nodeType" :key="k" :value="k">{{ t }}</option>
              </select>
              <select v-model="nodeForm.channel">
                <option value="">渠道</option>
                <option v-for="s in channels" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div class="row">
              <input v-model.number="nodeForm.reach" type="number" min="0" placeholder="直接触达（粉丝/阅读）" />
              <select v-model.number="nodeForm.post_id">
                <option :value="null">关联舆情（可选）</option>
                <option v-for="p in posts" :key="p.id" :value="p.id">#{{ p.id }} {{ p.title }}</option>
              </select>
              <label class="key-check"><input type="checkbox" v-model="nodeForm.is_key" /> ⭐关键节点</label>
            </div>
            <input v-model="nodeForm.note" placeholder="备注（如 转发暗访片段并配文质疑）" />
            <div class="row">
              <button class="save" type="submit">沉淀节点</button>
              <button type="button" class="ghost" @click="nodeFormFor=null">取消</button>
            </div>
          </form>

          <!-- 转发关系表单 -->
          <form v-if="edgeFormFor===g.id" class="mini-form" @submit.prevent="submitEdge(g)">
            <div class="row">
              <select v-model.number="edgeForm.from_node_id" required>
                <option :value="null">上游（转发出）</option>
                <option v-for="n in detail.nodes" :key="n.id" :value="n.id">L{{ n.depth }} {{ short(n.name,10) }}</option>
              </select>
              <select v-model="edgeForm.edge_type">
                <option v-for="(t,k) in dict.edgeType" :key="k" :value="k">{{ t }}</option>
              </select>
              <select v-model.number="edgeForm.to_node_id" required>
                <option :value="null">下游（被转发/被报道）</option>
                <option v-for="n in detail.nodes" :key="n.id" :value="n.id">L{{ n.depth }} {{ short(n.name,10) }}</option>
              </select>
            </div>
            <div class="row">
              <input v-model.number="edgeForm.reposts" type="number" min="0" placeholder="转发次数（≥1500 判激增）" />
              <input v-model="edgeForm.note" placeholder="备注" />
            </div>
            <div class="row">
              <button class="save" type="submit">沉淀转发关系</button>
              <button type="button" class="ghost" @click="edgeFormFor=null">取消</button>
            </div>
          </form>

          <!-- 节点清单 -->
          <div class="g-cols">
            <div class="col">
              <h5>🕸 传播节点（{{ detail.nodes.length }}）<em v-if="detail.keyNodes.length">⭐ 关键 {{ detail.keyNodes.length }}</em></h5>
              <div class="node-list">
                <div v-for="n in detail.nodes" :key="n.id" class="node" :class="[n.node_type,{key:n.is_key}]">
                  <span class="n-ico">{{ nodeIcon(n.node_type) }}</span>
                  <div class="n-body">
                    <b>{{ n.name }}<i v-if="n.is_key" class="star">⭐</i></b>
                    <small>{{ n.typeText }} · {{ n.channel||'未知渠道' }} · L{{ n.depth }} · 触达 {{ fmt(n.reach) }}</small>
                    <small v-if="n.post_title">关联《{{ n.post_title }}》</small>
                    <small v-if="n.note" class="n-note">{{ n.note }}</small>
                  </div>
                </div>
              </div>
            </div>
            <div class="col">
              <h5>🔀 转发关系（{{ detail.edges.length }}）</h5>
              <div class="edge-list">
                <div v-for="e in detail.edges" :key="e.id" class="edge">
                  <span class="e-from">{{ short(e.from_name,10) }}</span>
                  <span class="e-arrow" :class="e.edge_type">{{ e.edgeText }} ⟶</span>
                  <span class="e-to">{{ short(e.to_name,10) }}</span>
                  <b>{{ fmt(e.reposts) }}转 · 扩散约{{ fmt(e.reposts*5) }}</b>
                </div>
                <div v-if="!detail.edges.length" class="none-sm">暂无转发关系</div>
              </div>
            </div>
          </div>

          <!-- 传播变更时间线 -->
          <div class="tl-block">
            <h5>🕒 传播变更留痕（{{ detail.logs.length }}）</h5>
            <div class="tl">
              <div v-for="l in detail.logs" :key="l.id" class="tl-item" :class="logClass(l.action)">
                <span class="tl-dot"></span>
                <div class="tl-body">
                  <b>{{ l.action }}</b>
                  <span>{{ l.detail }}</span>
                  <em>{{ l.operator }} · {{ l.time }}</em>
                </div>
              </div>
            </div>
          </div>
        </div>

        <button class="toggle-btn" @click="toggle(g)">{{ detailId===g.id ? '收起详情' : '🔍 传播图谱与节点' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const items = ref([])
const summary = ref({ stages: {} })
const dict = ref({ stage: {}, nodeType: {}, edgeType: {} })
const filter = reactive({ stage: '' })
const topics = ref([])
const posts = ref([])
const showCreate = ref(false)
const form = ref({ title: '', topic: '', post_id: null, crisis_id: null, origin_name: '', origin_text: '' })
const detailId = ref(null)
const detail = ref(null)
const nodeFormFor = ref(null)
const edgeFormFor = ref(null)
const nodeForm = reactive({ name: '', node_type: 'user', channel: '', reach: 0, post_id: null, is_key: false, note: '' })
const edgeForm = reactive({ from_node_id: null, to_node_id: null, edge_type: 'repost', reposts: 0, note: '' })

const isAdmin = computed(() => store.user.role === 'admin')
const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const openCrises = computed(() => store.crises.filter((c) => c.status !== 'closed'))
const channels = ['微博', '微信', '新闻', '知乎', '抖音', '论坛']

const svgW = 900
const ROW_H = 110
const COL_W = 170
function svgH(d) {
  const maxDepth = Math.max(0, ...d.nodes.map((n) => n.depth || 0))
  return (maxDepth + 1) * ROW_H + 20
}
function layers(d) {
  const m = {}
  for (const n of d.nodes) {
    const k = n.depth || 0
    ;(m[k] ||= []).push(n)
  }
  return m
}
function nodePos(id, d) {
  const lm = layers(d)
  for (const k of Object.keys(lm)) {
    const arr = lm[k]
    const idx = arr.findIndex((n) => n.id === id)
    if (idx >= 0) {
      const x = svgW / (arr.length + 1) * (idx + 1)
      const y = (+k) * ROW_H + 60
      return { x, y }
    }
  }
  return { x: svgW / 2, y: 60 }
}
function edgePath(e, d) {
  const a = nodePos(e.from_node_id, d), b = nodePos(e.to_node_id, d)
  const my = (a.y + b.y) / 2
  return `M${a.x},${a.y + 22} C${a.x},${my} ${b.x},${my} ${b.x},${b.y - 22}`
}

function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function fmt(n) { return Number(n || 0).toLocaleString() }
function short(s, len) { s = String(s || ''); return s.length > len ? s.slice(0, len) + '…' : s }
function nodeIcon(t) { return { origin: '📍', kol: '⭐', media: '📰', official: '🏛️', user: '👤' }[t] || '👤' }
function logClass(a) {
  return { '阶段变化': 'l-stage', '传播激增': 'l-surge', '节点沉淀': 'l-node', '转发关系': 'l-edge',
    '关键节点': 'l-key', '关联预警': 'l-alert', '关联危机': 'l-crisis', '工单生成': 'l-wo' }[a] || ''
}

async function load() {
  const d = await store.fetchPropagation(filter.stage ? { stage: filter.stage } : null)
  items.value = d.items
  summary.value = d.summary
  dict.value = d.dict
  if (detailId.value) {
    detail.value = await store.fetchPropGraph(detailId.value)
  }
}
function setStage(k) { filter.stage = k; load() }

async function loadMeta() {
  topics.value = await store.fetchTopics()
  posts.value = await store.fetchPosts({})
}

async function create() {
  try {
    const r = await store.createPropGraph({ ...form.value })
    form.value = { title: '', topic: '', post_id: null, crisis_id: null, origin_name: '', origin_text: '' }
    showCreate.value = false
    detailId.value = r.id
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}

async function toggle(g) {
  if (detailId.value === g.id) { detailId.value = null; detail.value = null; return }
  detailId.value = g.id
  detail.value = await store.fetchPropGraph(g.id)
}

function resetNodeForm() {
  Object.assign(nodeForm, { name: '', node_type: 'user', channel: '', reach: 0, post_id: null, is_key: false, note: '' })
}
function openNode(g) { nodeFormFor.value = g.id; edgeFormFor.value = null; resetNodeForm() }
async function submitNode(g) {
  try {
    await store.propOp(g.id, 'nodes', { ...nodeForm })
    nodeFormFor.value = null
    await load()
    store.msg('传播节点已沉淀', 'success')
  } catch (e) { store.msg(e.message, 'warn') }
}
function openEdge(g) {
  if (detail.value.nodes.length < 2) { store.msg('至少需要 2 个节点才能建立转发关系', 'warn'); return }
  edgeFormFor.value = g.id; nodeFormFor.value = null
  Object.assign(edgeForm, { from_node_id: null, to_node_id: null, edge_type: 'repost', reposts: 0, note: '' })
}
async function submitEdge(g) {
  try {
    await store.propOp(g.id, 'edges', { ...edgeForm })
    edgeFormFor.value = null
    await load()
    store.msg('转发关系已沉淀', 'success')
  } catch (e) { store.msg(e.message, 'warn') }
}

async function changeStage(g) {
  const opts = Object.entries(dict.value.stage).map(([k, t]) => `${k}=${t}`).join(' / ')
  const input = prompt(`研判「${g.title}」影响阶段（${opts}）\n输入 stage 键（当前 ${g.stage}=${g.stageText}）：`, g.stage)
  if (input == null) return
  const stage = input.trim()
  if (!dict.value.stage[stage]) { store.msg('阶段取值无效', 'warn'); return }
  const note = prompt('研判依据/备注（可留空）：', '')
  if (note === null) return
  try {
    await store.propOp(g.id, 'stage', { stage, note: note.trim() })
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}

async function openBind(g) {
  if (g.crisis_id && !confirm(`当前已关联危机 #${g.crisis_id}，确定改绑/解绑？\n确定=选择新危机或输入 0 解绑`)) return
  const list = openCrises.value.map((c) => `#${c.id} ${c.title}`).join('\n')
  const input = prompt(`输入要关联的危机事件 id（输入 0 解绑）：\n${list}`, g.crisis_id || '')
  if (input == null) return
  const raw = input.trim()
  if (!raw) return
  try {
    await store.propOp(g.id, 'bind-crisis', { crisis_id: raw === '0' ? null : +raw, note: '人工关联传播路径与危机处置' })
    await load()
    store.msg(raw === '0' ? '已解除危机关联' : '已关联危机事件，纳入处置闭环', 'success')
  } catch (e) { store.msg(e.message, 'warn') }
}

async function dispatch(g) {
  if (!g.crisis_id) {
    store.msg('该路径尚未关联危机事件，请先关联后再生成工单', 'warn')
    return
  }
  if (!confirm(`按当前「${g.stageText}」阶段一键生成跨角色处置工单？\n将写入危机 #${g.crisis_id}，并触发协同工单分派通知。`)) return
  try {
    const r = await store.propDispatch(g.id, {})
    await load()
    store.msg(`已生成工单：#${r.ids.join('、#')}`, 'success')
  } catch (e) { store.msg(e.message, 'warn') }
}
function goWork() { store.tab = 'work' }

async function remove(g) {
  if (!confirm(`删除传播路径「${g.title}」？节点、转发关系与变更留痕将一并删除（不影响危机/预警/工单）。`)) return
  try {
    await store.delPropGraph(g.id)
    if (detailId.value === g.id) { detailId.value = null; detail.value = null }
    await load()
  } catch (e) { store.msg(e.message, 'warn') }
}

// 从危机卡片跳转并预填话题建档
watch(() => store.propHraftCrisis, (cid) => {
  if (!cid) return
  const c = store.crises.find((x) => x.id === cid)
  if (c) {
    form.value.title = c.title + '传播路径'
    form.value.topic = c.topic || ''
    form.value.crisis_id = c.id
    showCreate.value = true
  }
  store.propHraftCrisis = null
})

let timer = null
onMounted(async () => {
  await Promise.all([load(), loadMeta()])
  timer = setInterval(load, 4000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.prop{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.add{background:linear-gradient(135deg,#5e35b1,#4527a0);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.chip{background:#0f1b38;border:1px solid rgba(120,160,220,0.18);color:#8ba2c8;border-radius:14px;padding:4px 12px;font-size:11px;cursor:pointer;font-family:inherit;}
.chip.on{border-color:#7e57c2;color:#fff;background:#241a3a;}
.chip.outbreak.on{border-color:#ef5350;background:#3a1a24;color:#ffcdd2;}
.chip.spread.on{border-color:#ff9800;background:#33230e;color:#ffe0b2;}
.chip.linked{border-color:rgba(38,166,154,.5);color:#80cbc4;background:#0d2826;cursor:default;}
.me{margin-left:auto;font-size:11px;color:#8ba2c8;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 12px;}
.hint{margin:0;font-size:11px;color:#5b6f94;line-height:1.5;}
.p-form,.mini-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.mini-form{margin-top:10px;border-color:rgba(126,87,194,.35);background:#141029;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.row>*{flex:1;min-width:140px;}
input,select,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.save{background:#5e35b1;border:none;color:#fff;font-weight:600;cursor:pointer;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.none{color:#5b6f94;text-align:center;padding:32px;}
.glist{display:flex;flex-direction:column;gap:12px;}
.gcard{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-left:4px solid #78909c;border-radius:12px;padding:14px 16px;position:relative;}
.gcard.seed{border-left-color:#78909c;}.gcard.spread{border-left-color:#ff9800;}.gcard.outbreak{border-left-color:#ef5350;}
.gcard.recession{border-left-color:#42a5f5;}.gcard.calm{border-left-color:#66bb6a;}
.g-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.stage-tag{font-size:10px;padding:2px 10px;border-radius:6px;flex:none;font-weight:700;}
.stage-tag.seed{background:#37474f;color:#cfd8dc;}.stage-tag.spread{background:#3e2723;color:#ffcc80;}
.stage-tag.outbreak{background:#4a1518;color:#ef9a9a;}.stage-tag.recession{background:#0d2137;color:#90caf9;}
.stage-tag.calm{background:#1b5e20;color:#a5d6a7;}
.g-title{color:#fff;font-size:15px;}
.g-topic{font-size:10px;color:#ce93d8;background:#1e1430;border:1px solid rgba(126,87,194,.35);border-radius:5px;padding:1px 7px;}
.g-crisis{font-size:10px;color:#80cbc4;background:#0d2826;border:1px solid rgba(38,166,154,.3);border-radius:5px;padding:1px 7px;}
.g-crisis.none-link{color:#5b6f94;background:transparent;border-color:rgba(120,160,220,.15);}
.del{margin-left:auto;background:none;border:none;color:#ef5350;font-size:14px;cursor:pointer;}
.g-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:#8ba2c8;margin:9px 0 4px;}
.g-meta i{color:#ce93d8;font-style:normal;}
.g-origin{font-size:11px;color:#aebadd;}
.toggle-btn{margin-top:10px;background:#16263f;border:1px solid rgba(126,87,194,.35);color:#b39ddb;border-radius:8px;padding:6px 12px;font-size:11px;cursor:pointer;font-family:inherit;}
.g-detail{margin-top:12px;border-top:1px dashed rgba(126,87,194,.25);padding-top:12px;}
.graph-wrap{background:#0a1024;border:1px solid rgba(126,87,194,.2);border-radius:10px;overflow-x:auto;}
.graph{width:100%;min-height:200px;}
.edge-line{opacity:.75;}
.edge-label{fill:#8fa3cc;font-size:9px;}
.gnode{stroke-width:2;}
.gnode.origin{fill:#1e1430;stroke:#ce93d8;}.gnode.kol{fill:#33230e;stroke:#ffb300;}
.gnode.media{fill:#0d2137;stroke:#42a5f5;}.gnode.official{fill:#0c2622;stroke:#26a69a;}
.gnode.user{fill:#1a2235;stroke:#5b6f94;}.gnode.key{stroke-width:3;filter:drop-shadow(0 0 4px rgba(255,213,79,.5));}
.gnode-ico{font-size:14px;}
.gnode-name{fill:#dbe4f3;font-size:10px;font-weight:600;}
.gnode-sub{fill:#5b6f94;font-size:8px;}
.g-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0;}
.op{background:#16263f;border:1px solid rgba(120,160,220,.25);color:#aebadd;border-radius:7px;padding:6px 11px;font-size:11px;cursor:pointer;font-family:inherit;}
.op:disabled{opacity:.4;cursor:not-allowed;}
.op.addn{border-color:rgba(126,87,194,.5);color:#b39ddb;}
.op.adde{border-color:rgba(66,165,245,.5);color:#90caf9;}
.op.stage{border-color:rgba(255,179,0,.5);color:#ffe082;}
.op.bind{border-color:rgba(38,166,154,.5);color:#80cbc4;}
.op.dispatch{background:linear-gradient(135deg,#00897b,#00695c);border:none;color:#fff;font-weight:600;}
.op.jump{border-color:rgba(120,160,220,.3);color:#8ba2c8;}
.key-check{display:flex;align-items:center;gap:5px;font-size:12px;color:#aebadd;flex:none;}
.key-check input{width:auto;}
.g-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;}
@media(max-width:800px){.g-cols{grid-template-columns:1fr;}}
.col{background:#13233f;border-radius:10px;padding:12px;}
h5{margin:0 0 8px;color:#ce93d8;font-size:12px;display:flex;align-items:center;gap:8px;}
h5 em{font-style:normal;font-size:10px;color:#ffd54f;}
.node-list,.edge-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto;}
.node{display:flex;gap:9px;background:#0f1b38;border-radius:8px;padding:7px 9px;border-left:3px solid #5b6f94;}
.node.origin{border-left-color:#ce93d8;}.node.kol{border-left-color:#ffb300;}.node.media{border-left-color:#42a5f5;}
.node.official{border-left-color:#26a69a;}.node.key{background:#241f12;}
.n-ico{font-size:15px;flex:none;}
.n-body{min-width:0;}
.n-body b{color:#dbe4f3;font-size:12px;}
.star{font-style:normal;margin-left:4px;}
.n-body small{display:block;color:#5b6f94;font-size:10px;}
.n-body .n-note{color:#8ba2c8;}
.edge{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#0f1b38;border-radius:7px;padding:6px 9px;font-size:11px;}
.e-from{color:#dbe4f3;}.e-arrow{font-size:10px;color:#90caf9;}.e-arrow.report{color:#b39ddb;}.e-to{color:#dbe4f3;}
.edge b{margin-left:auto;color:#ce93d8;font-size:10px;font-weight:600;}
.none-sm{color:#5b6f94;font-size:11px;padding:6px;}
.tl-block{margin-top:12px;background:#13233f;border-radius:10px;padding:12px;}
.tl{border-left:2px solid #342257;padding-left:14px;display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto;}
.tl-item{position:relative;}
.tl-dot{position:absolute;left:-19px;top:4px;width:9px;height:9px;border-radius:50%;background:#5b6f94;}
.tl-item.l-stage .tl-dot{background:#ef5350;}.tl-item.l-surge .tl-dot{background:#ff5252;box-shadow:0 0 6px #ef5350;}
.tl-item.l-node .tl-dot{background:#b39ddb;}.tl-item.l-edge .tl-dot{background:#42a5f5;}
.tl-item.l-alert .tl-dot{background:#ffab91;}.tl-item.l-crisis .tl-dot{background:#80cbc4;}.tl-item.l-wo .tl-dot{background:#ffe082;}
.tl-body b{color:#dbe4f3;font-size:12px;display:block;}
.tl-body span{color:#8ba2c8;font-size:11px;}
.tl-body em{color:#5b6f94;font-size:10px;font-style:normal;display:block;margin-top:2px;}
</style>
