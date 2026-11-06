// Editorial choices that cannot be derived from the upstream manifest:
// which animation sits in each motion slot, and which animations back each
// work-status tier. Every name is resolved against the synced action list, so a
// renamed or dropped upstream animation degrades to the next candidate instead
// of producing a broken reference.

export const motionSlots = {
  idle: ['待机呼吸起伏'],
  turn: ['待机呼吸起伏'],
  'moving-left': ['提篮行走原地'],
  'moving-right': ['提篮行走原地'],
  dragging: ['待机尾巴轻甩'],
  waiting: ['待机气息悬停'],
}

export const workStatus = {
  // 0 thinking / 1 working / 2 result / 3 waiting / 4 success / 5 error
  thinking: ["咬手指思索","疑惑挠头","抬头望天"],
  working: ["打字哑剧","写字哑剧","翻阅书册"],
  result: ["翻阅书册","点头肯定","双手抚胸礼"],
  waiting: ["待机呼吸起伏","待机气息悬停","待机微晃重心"],
  success: ["狂喜跃起","鼓掌","开心蹦跳"],
  error: ["沮丧垂头v2","无语叹气","扶额无语"],
}

// Animation played when the user clicks the pet; defaults to every animation.
export const clickExclude = ['待机呼吸起伏']

export const categoryOrder = [
  "待机",
  "手势互动",
  "礼仪致意",
  "情绪反应",
  "工作职业",
  "娱乐休闲",
  "才艺表演",
  "运动健身",
  "武术格斗",
  "模仿动物",
  "龙族特性",
  "魔法特效",
  "日常起居",
  "吃喝",
  "手工节日"
]

export const categoryTitles = {
  "待机": "待机",
  "手势互动": "手势互动",
  "礼仪致意": "礼仪致意",
  "情绪反应": "情绪反应",
  "工作职业": "工作职业",
  "娱乐休闲": "娱乐休闲",
  "才艺表演": "才艺表演",
  "运动健身": "运动健身",
  "武术格斗": "武术格斗",
  "模仿动物": "模仿动物",
  "龙族特性": "龙族特性",
  "魔法特效": "魔法特效",
  "日常起居": "日常起居",
  "吃喝": "吃喝",
  "手工节日": "手工节日"
}
