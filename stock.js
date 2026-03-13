require('dotenv').config();
const { OpenAI } = require('openai');
const schedule = require('node-schedule');
const axios = require('axios');

// ================== 配置区 ==================
const DASHSCOPE_API_KEY = process.env.LLM_API_KEY;

const BASE_URL = process.env.LLM_BASE_URL;

const WECHAT_WEBHOOK = process.env.WECHAT_WEBHOOK;

// 关注列表（用于提示模型重点关注哪些股票/指数）
const WATCHLIST_NAMES = [
  '上证指数',
  '深证成指',
  '创业板指',
  '沪深300',
  '贵州茅台',
  '宁德时代',
  '东方财富',
  '中国中免',
  '金山办公'
  // 你可以继续加群里常提到的短线票名
];

const MORNING_TIME   = '30 8 * * 1-5';   // 08:30 早报
const NOON_TIME      = '0 12 * * 1-5';  // 11:45 中盘快讯
const AFTERNOON_TIME = '0 16 * * 1-5';   // 16:00 收盘复盘
// =============================================================

const openai = new OpenAI({
  apiKey: DASHSCOPE_API_KEY,
  baseURL: BASE_URL,
});

// WebSearch MCP 配置
const WEBSEARCH_MCP_URL = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';

// 调用 WebSearch MCP 搜索最新信息
async function webSearch(query) {
  try {
    // MCP 协议调用格式
    const response = await axios.post(
      WEBSEARCH_MCP_URL,
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'web_search',
          arguments: {
            query: query
          }
        },
        id: `search_${Date.now()}`
      },
      {
        headers: {
          'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    // 处理 MCP 响应
    if (response.data) {
      if (response.data.error) {
        console.error('MCP 错误:', response.data.error);
        return null;
      }
      if (response.data.result) {
        // 如果 result 是对象，直接返回
        if (typeof response.data.result === 'object') {
          return response.data.result;
        }
        // 如果 result 是字符串，尝试解析
        if (typeof response.data.result === 'string') {
          try {
            return JSON.parse(response.data.result);
          } catch (e) {
            return { content: response.data.result };
          }
        }
      }
    }
    return null;
  } catch (err) {
    console.error('WebSearch MCP 调用失败:', err.message);
    if (err.response) {
      console.error('响应状态:', err.response.status);
      console.error('响应详情:', JSON.stringify(err.response.data, null, 2));
    }
    return null;
  }
}

async function generateMessage(period) {
  // 获取当前日期
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  
  // 早报需要查询昨天的数据（隔夜美股等）
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getFullYear()}年${yesterday.getMonth() + 1}月${yesterday.getDate()}日`;

  // 构建搜索查询
  let searchQuery = '';
  let queryDateStr = dateStr;
  if (period === 'morning') {
    // 早报查询昨天的数据（隔夜美股、昨日收盘等）
    queryDateStr = yesterdayStr;
    searchQuery = `${yesterdayStr} 隔夜美股 道指 纳指 标普500 收盘 ${dateStr} 亚太市场 日经 韩国综指 富时中国A50 央行公开市场操作 最新政策 ${WATCHLIST_NAMES.join(' ')}`;
  } else if (period === 'noon') {
    searchQuery = `${dateStr} A股午盘 上证指数 深证成指 创业板指 成交额 涨停 跌停 板块涨幅 ${WATCHLIST_NAMES.join(' ')}`;
  } else {
    searchQuery = `${dateStr} A股收盘 上证指数 深证成指 创业板指 成交额 北向资金 连板高度 涨停 跌停 炸板率 板块涨幅 ${WATCHLIST_NAMES.join(' ')}`;
  }

  // 调用 WebSearch MCP 获取最新信息
  console.log(`[${period}] 正在通过 WebSearch MCP 搜索最新信息...`);
  console.log(`搜索查询: ${searchQuery}`);
  const searchResult = await webSearch(searchQuery);
  
  let searchContext = '';
  if (searchResult) {
    // 处理不同类型的搜索结果格式
    let resultText = '';
    if (searchResult.content) {
      resultText = typeof searchResult.content === 'string' 
        ? searchResult.content 
        : JSON.stringify(searchResult.content, null, 2);
    } else if (searchResult.text) {
      resultText = searchResult.text;
    } else if (searchResult.results) {
      resultText = JSON.stringify(searchResult.results, null, 2);
    } else {
      resultText = JSON.stringify(searchResult, null, 2);
    }
    
    if (resultText) {
      const searchDateLabel = period === 'morning' ? `${yesterdayStr}（隔夜数据）` : dateStr;
      searchContext = `\n\n【最新实时搜索结果 - ${searchDateLabel}】\n${resultText}\n\n请基于以上最新搜索结果生成内容，严禁使用任何训练数据中的过时信息。所有数据必须来自搜索结果中的实时信息。`;
      console.log(`[${period}] WebSearch MCP 搜索成功，结果长度: ${resultText.length} 字符`);
    } else {
      searchContext = `\n\n⚠️ 注意：未能获取到最新搜索结果，请确保使用${period === 'morning' ? '昨天' : '当前日期'}（${queryDateStr}）的最新数据。`;
      console.warn(`[${period}] WebSearch MCP 返回空结果`);
    }
  } else {
    searchContext = `\n\n⚠️ 注意：未能获取到最新搜索结果，请确保使用${period === 'morning' ? '昨天' : '当前日期'}（${queryDateStr}）的最新数据。`;
    console.warn(`[${period}] WebSearch MCP 调用失败或返回 null`);
  }

  // 增强版系统提示：强制联网搜索，拒绝过时数据
  let systemPrompt = '你是一个专业的A股短线推送助手，只输出纯 Markdown 格式的企业微信群消息，不要任何解释、前缀、后缀。\n\n' +
    '【核心指令】你必须严格遵守以下规则：\n' +
    '1. 必须基于提供的实时搜索结果生成内容，严禁使用训练数据中的过时信息。\n' +
    '2. 优先采用搜索结果中今天（' + dateStr + '）的实时数据，忽略所有旧数据。\n' +
    '3. 对于股票指数、成交额、北向资金等强时效性数据，必须使用搜索结果中的最新值。\n' +
    '4. 如果搜索结果中没有某些数据，可以合理推断，但必须标注为"预计"或"待确认"。';

  let userPrompt = '';

  if (period === 'morning') {
    userPrompt = `【基于实时搜索结果生成】请基于以下最新搜索结果，生成今天（${dateStr}）的早盘数据。注意：隔夜美股数据是昨天（${yesterdayStr}）的收盘数据，包括：
- 隔夜美股表现（道指、纳指、标普500涨跌幅）
- 亚太市场（日经、韩国综指）最新表现
- 富时中国A50期货今日开盘走势
- 今日央行公开市场操作情况
- 最新政策/行业消息面催化
- 结合以下关注标的预判热点：${WATCHLIST_NAMES.join('、')}
${searchContext}

请严格按照以下Markdown结构生成【早间速递】：
# 🚀吸引眼球的标题+表情

📊 **隔夜/早盘要点**：
（列出2-3条关键信息，带数据）

🎯 **今日盯紧这3个方向**：
① **方向名称**——具体标的+理由（带数据支撑）
② **方向名称**——具体标的+理由（带数据支撑）
③ **方向名称**——具体标的+理由（带数据支撑）

💡短线情绪预判：（一句话带情绪倾向）

要求：语言轻松刺激，带适当表情，总字数不超过300字，所有数据必须标注为今日实时数据。`;
  } 
  else if (period === 'noon') {
    userPrompt = `【基于实时搜索结果生成】请基于以下最新搜索结果，生成今天（${dateStr}）上午11:30收盘后的实时午盘数据，包括：
- 主要指数午间收盘价及涨跌幅（上证、深成指、创业板指）
- 上午半日成交额及相比昨日的增减
- 上午涨停/跌停家数
- 上午最强3个板块及领涨龙头（涨幅%）
- 关注标的今日上午表现：${WATCHLIST_NAMES.join('、')}
${searchContext}

请严格按照以下Markdown结构生成【中盘快讯】：
【中盘快讯】⏰午间速递！

1️⃣ **指数红肥绿瘦**🔥：上证+?%（?点）、深成指+?%、创业板+?%！两市半日成交**?,???亿**（↑↓?%）💥

2️⃣ **最强板块TOP3**👇：
🔸 **板块一**——龙头股+涨幅%🔥
🔸 **板块二**——龙头股+涨幅%
🔸 **板块三**——龙头股+涨幅%

3️⃣ **资金博弈爆点**💥：（2-3条个股异动或资金流向亮点）

4️⃣ **下午留意**👉：（2-3个方向，用“留意”“异动”“关注”等中性词）

要求：语言快节奏、刺激，带表情，150-250字，所有数据必须是今日实时数据。`;
  } 
  else {
    userPrompt = `【基于实时搜索结果生成】请基于以下最新搜索结果，生成今天（${dateStr}）下午15:00收盘后的完整复盘数据，包括：
- 三大指数收盘价及涨跌幅
- 两市总成交额及相比昨日变化
- 北向资金全天净流入/流出金额
- 连板高度及涨停梯队情况
- 今日最强题材/最弱题材
- 关注标的今日表现：${WATCHLIST_NAMES.join('、')}
${searchContext}

请严格按照以下Markdown结构生成【晚间复盘】：
【晚间复盘】${dateStr}

1. **全天指数收盘 + 成交额 + 北向**
上证指数收报?,???.??（±?%），深证成指±?%，创业板指±?%；两市成交额?,???亿元（±?%）；北向资金±???亿。

2. **连板高度 & 情绪变化**
连板高度?连板（股票名），涨停?家，跌停?家，炸板率?%，情绪??。

3. **今日短线得失点**
涨幅Top板块/个股、炸板情况、关注标的中的亮点/坑点。

4. **明日短线风格预判**
（高低切换/防守为主/进攻延续 等预判）

要求：语言专业带复盘感，250-350字，所有数据必须标注为今日实时数据，绝对不使用任何历史数据。`;
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1200
    });

    let content = response.choices[0].message.content.trim();
    
    // 后处理：如果内容为空或疑似未联网，添加警告
    if (!content || content.length < 50) {
      content = '⚠️ **数据获取异常**：未能获取到今日实时数据，请检查 WebSearch MCP 功能是否正常。';
    }
    
    return content;
  } catch (err) {
    console.error(`大模型调用失败 (${period}):`, err.message);
    if (err.response) {
      console.error('响应详情:', JSON.stringify(err.response.data, null, 2));
    }
    return `【系统错误】生成失败：${err.message || '未知错误'}\n请检查API Key、模型权限、网络或余额。`;
  }
}

async function sendToWechat(content, period) {
  const titleMap = {
    morning: '【早间速递】',
    noon: '【中盘快讯】',
    afternoon: '【收盘复盘】'
  };

  const payload = {
    msgtype: 'markdown',
    markdown: {
      content: `${titleMap[period] || ''}\n\n${content}`
    }
  };

  try {
    const res = await axios.post(WECHAT_WEBHOOK, payload, { timeout: 10000 });
    if (res.data.errcode === 0) {
      console.log(`${period} 推送成功`);
    } else {
      console.error(`${period} 推送失败:`, res.data);
    }
  } catch (err) {
    console.error(`${period} 推送异常:`, err.message);
  }
}

// ================== 定时任务 ==================
async function morningJob() {
  console.log(`[${new Date().toLocaleString('zh-CN')}] 早报任务启动...`);
  const msg = await generateMessage('morning');
  console.log(msg);
  await sendToWechat(msg, 'morning');
}

async function noonJob() {
  console.log(`[${new Date().toLocaleString('zh-CN')}] 中盘任务启动...`);
  const msg = await generateMessage('noon');
  console.log(msg);
  await sendToWechat(msg, 'noon');
}

async function afternoonJob() {
  console.log(`[${new Date().toLocaleString('zh-CN')}] 复盘任务启动...`);
  const msg = await generateMessage('afternoon');
  console.log(msg);
  await sendToWechat(msg, 'afternoon');
}

// ================== 启动 ==================
console.log('🚀 A股短线三连推服务已启动！（阿里云百炼 + WebSearch MCP 实时搜索）');
console.log(`早报: 08:30 | 中盘: 11:45 | 复盘: 16:00（工作日）`);

schedule.scheduleJob(MORNING_TIME, morningJob);
schedule.scheduleJob(NOON_TIME, noonJob);
schedule.scheduleJob(AFTERNOON_TIME, afternoonJob);

// 测试：立即跑一次（生产环境可注释）
// morningJob();
// noonJob();
// afternoonJob();