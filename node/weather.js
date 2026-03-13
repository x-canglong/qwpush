require('dotenv').config();
const { OpenAI } = require('openai');
const schedule = require('node-schedule');
const axios = require('axios');

// ================== 配置区 ==================
const DASHSCOPE_API_KEY = process.env.LLM_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL;
const WECHAT_WEBHOOK = process.env.WECHAT_WEBHOOK;

// 要播报天气的城市（可多个）
const WEATHER_CITIES = ['北京', '上海'];

// 每日天气早报时间（默认 7:30）
const MORNING_WEATHER_TIME = '30 7 * * *';
// =============================================

const openai = new OpenAI({
  apiKey: DASHSCOPE_API_KEY,
  baseURL: BASE_URL,
});

const WEBSEARCH_MCP_URL = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';

async function webSearch(query) {
  try {
    const response = await axios.post(
      WEBSEARCH_MCP_URL,
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'web_search',
          arguments: { query }
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

    if (response.data?.error) {
      console.error('MCP 错误:', response.data.error);
      return null;
    }
    if (response.data?.result) {
      if (typeof response.data.result === 'object') return response.data.result;
      if (typeof response.data.result === 'string') {
        try { return JSON.parse(response.data.result); } catch (e) { return { content: response.data.result }; }
      }
    }
    return null;
  } catch (err) {
    console.error('WebSearch MCP 调用失败:', err.message);
    return null;
  }
}

async function generateWeatherMessage() {
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  const cityList = WEATHER_CITIES.join('、');
  const searchQuery = `${dateStr} ${cityList} 今日天气 气温 降水 空气质量`;

  console.log('[weather] 正在通过 WebSearch MCP 搜索天气...');
  console.log('搜索查询:', searchQuery);
  const searchResult = await webSearch(searchQuery);

  let searchContext = '';
  if (searchResult) {
    let resultText = '';
    if (searchResult.content) {
      resultText = typeof searchResult.content === 'string' ? searchResult.content : JSON.stringify(searchResult.content, null, 2);
    } else if (searchResult.text) {
      resultText = searchResult.text;
    } else if (searchResult.results) {
      resultText = JSON.stringify(searchResult.results, null, 2);
    } else {
      resultText = JSON.stringify(searchResult, null, 2);
    }
    if (resultText) {
      searchContext = `\n\n【最新天气搜索结果 - ${dateStr}】\n${resultText}\n\n请严格基于以上搜索结果生成天气早报，所有数据必须来自搜索结果。`;
      console.log('[weather] WebSearch MCP 搜索成功，结果长度:', resultText.length, '字符');
    } else {
      searchContext = `\n\n⚠️ 未能获取到最新天气搜索结果，请基于${dateStr}合理生成${cityList}的天气提示。`;
      console.warn('[weather] WebSearch MCP 返回空结果');
    }
  } else {
    searchContext = `\n\n⚠️ 未能获取到最新天气搜索结果，请基于${dateStr}合理生成${cityList}的天气提示。`;
    console.warn('[weather] WebSearch MCP 调用失败或返回 null');
  }

  const systemPrompt = '你是一个简洁的天气早报助手，只输出纯 Markdown 格式的企业微信群消息，不要任何解释、前缀、后缀。\n\n' +
    '【规则】必须基于提供的实时搜索结果生成内容；若无某项数据可标注"待查"或合理推断。';

  const userPrompt = `【基于实时搜索结果生成】请基于以下最新搜索结果，生成今天（${dateStr}）的天气早报，覆盖城市：${cityList}。

需要包含：
- 各城市今日天气（晴/阴/雨等）、气温范围、是否有雨/雪
- 穿衣与出行建议（是否带伞、增减衣物）
- 空气质量（若有）
${searchContext}

请按以下 Markdown 结构生成【天气早报】：

# 🌤️ 今日天气早报 · ${dateStr}

**📍 城市天气**
- **城市名**：天气，气温 x°C～x°C，简要描述（降水/风/霾等）

**👔 穿衣与出行**
（1-2 句：穿衣建议、是否带伞、出行注意）

**🌬️ 空气质量**（若有）
（一句话或「待查」）

要求：语言简短清晰，带少量表情，总字数 150～250 字，数据必须来自搜索结果或标注为预计/待查。`;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.5,
      max_tokens: 800
    });

    let content = response.choices[0].message.content.trim();
    if (!content || content.length < 30) {
      content = '⚠️ **天气数据获取异常**：未能获取到今日天气，请检查 WebSearch MCP 或稍后重试。';
    }
    return content;
  } catch (err) {
    console.error('大模型调用失败 (weather):', err.message);
    return `【系统错误】天气早报生成失败：${err.message || '未知错误'}`;
  }
}

async function sendToWechat(content) {
  const payload = {
    msgtype: 'markdown',
    markdown: {
      content: `【天气早报】\n\n${content}`
    }
  };

  try {
    const res = await axios.post(WECHAT_WEBHOOK, payload, { timeout: 10000 });
    if (res.data.errcode === 0) {
      console.log('weather 推送成功');
    } else {
      console.error('weather 推送失败:', res.data);
    }
  } catch (err) {
    console.error('weather 推送异常:', err.message);
  }
}

async function weatherJob() {
  console.log(`[${new Date().toLocaleString('zh-CN')}] 天气早报任务启动...`);
  const msg = await generateWeatherMessage();
  console.log(msg);
//   await sendToWechat(msg);
}

// ================== 启动 ==================
console.log('🌤️ 天气早报服务已启动！（阿里云百炼 + WebSearch MCP）');
console.log('播报城市:', WEATHER_CITIES.join('、'));
console.log('定时:', MORNING_WEATHER_TIME, '（每日 7:30）');

schedule.scheduleJob(MORNING_WEATHER_TIME, weatherJob);

// 测试：取消下面注释可立即跑一次
weatherJob();
