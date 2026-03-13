import requests
import json
from datetime import datetime
import os
import sys

def _load_dotenv():
    for d in [os.path.dirname(os.path.abspath(__file__)), os.getcwd()]:
        path = os.path.join(d, ".env")
        if not os.path.isfile(path):
            path = os.path.join(os.path.dirname(d), ".env")
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    os.environ[k.strip()] = v.strip().strip('"').strip("'")
            break

_load_dotenv()

LLM_API_KEY = os.getenv("LLM_API_KEY")
LLM_BASE_URL = os.getenv("LLM_BASE_URL")
LLM_MODEL = os.getenv("LLM_MODEL")
AMAP_KEY = os.getenv("AMAP_KEY")
AMAP_WEATHER_URL = os.getenv("AMAP_WEATHER_URL")
AMAP_GEO_URL = os.getenv("AMAP_GEO_URL")
WECHAT_WEBHOOK_BASE_URL = os.getenv("WECHAT_WEBHOOK_BASE_URL")
WEATHER_KEY = os.getenv("WEATHER_KEY")
CITY = os.getenv("WEATHER_CITY")
MENTION_ALL = os.getenv("WEATHER_MENTION_ALL").lower() in ("1", "true", "yes")
DEBUGGER_WEATHER = os.getenv("DEBUGGER_WEATHER").lower() in ("1", "true", "yes")

def get_current_time():
    """获取当前时间字符串"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def _amap_city_to_adcode(city_name):
    """高德地理编码：城市名 -> adcode，失败返回 None"""
    if not AMAP_KEY:
        return None
    try:
        r = requests.get(
            AMAP_GEO_URL,
            params={"key": AMAP_KEY, "address": city_name},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("status") != "1" or not data.get("geocodes"):
            return None
        return data["geocodes"][0].get("adcode")
    except Exception as e:
        print(f"❌ 高德地理编码失败: {e}")
        return None

def get_weather_from_amap(city_name):
    """
    调用高德天气 API 获取实时天气（先地理编码取 adcode 再查天气）。
    返回格式化的天气文本，失败返回 None。
    """
    if not AMAP_KEY:
        print("❌ 未配置 AMAP_KEY")
        return None
    adcode = _amap_city_to_adcode(city_name)
    if not adcode:
        print(f"❌ 未解析到城市 adcode: {city_name}")
        return None
    try:
        r = requests.get(
            AMAP_WEATHER_URL,
            params={"key": AMAP_KEY, "city": adcode, "extensions": "base"},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        print(data)
        if data.get("status") != "1" or data.get("infocode") != "10000":
            print(f"❌ 高德天气返回异常: {data}")
            return None
        lives = data.get("lives") or []
        if not lives:
            return None
        live = lives[0]
        # 转为易读文本供 LLM 使用
        parts = [
            f"城市: {live.get('city', city_name)}",
            f"天气: {live.get('weather', '')}",
            f"温度: {live.get('temperature', '')}°C",
            f"风向: {live.get('winddirection', '')}",
            f"风力: {live.get('windpower', '')}级",
            f"湿度: {live.get('humidity', '')}%",
            f"发布时间: {live.get('reporttime', '')}",
        ]
        return "\n".join(parts)
    except Exception as e:
        print(f"❌ 高德天气调用失败: {e}")
        return None

def get_weather_from_llm():
    """
    先通过高德天气 API 查实时天气，再交给阿里云百炼生成 Markdown 报告。
    """
    date_str = get_current_time().split()[0]

    print(f"🔄 正在通过高德天气查询 {CITY} 实时天气...")
    weather_data = get_weather_from_amap(CITY)

    if weather_data:
        print(f"✅ 高德天气返回成功")
        search_context = f"\n\n【高德实时天气数据 - {date_str}】\n{weather_data}\n\n请严格基于以上数据生成天气报告，并补充穿衣与出行建议。"
    else:
        print("⚠️ 高德天气未返回结果，将请大模型基于常识生成提示")
        search_context = f"\n\n⚠️ 未获取到实时天气数据，请基于 {date_str} {CITY} 给出合理的天气与出行提示。"

    system_prompt = (
        "你是一个亲切、简洁的企业微信天气早报助手，只输出纯 Markdown 格式的消息，"
        "不要出现任何解释、思考过程、前缀、后缀或代码块标记。严格按照用户指定的结构和语气生成。"
    )
    user_prompt = f"""请基于以下高德实时天气数据，为森兰团队生成今天（{date_str}）{CITY}的天气早报。
                高德实时天气数据如下：
                {search_context}
                
                请严格按照以下格式和风格输出（注意顺序、emoji使用、语气温暖活泼）：
                ## 森兰今日天气预报（{date_str}）
                天气状况：XXX  
                气温范围：X°C ~ X°C  
                体感温度：约X°C（可选补充早晚感受）  
                风力风向：XXX风 X-X级  
                湿度范围：X% ~ X%（可选补充早晚变化）  
                紫外线强度：XXX（UV Index X，可选
                🌤️ 今日森兰天气XXX，XXX，是XXX的好日子！（1-2句总体感受 + 1个小提醒）
                👕 穿衣建议：建议穿XXX，搭配XXX，既XXX又XXX。（简洁1句）
                🚶 出行提示：天气XXX，建议XXX，注意XXX。（1-2句实用建议，提到是否带伞、防晒、补水、温差等）
                愿大家今天XXX，心情愉快，XXX！🌸☀️（温暖祝福，带1-2个表情）
                要求：
                - 所有数据必须来自高德提供的信息，若某项缺失可写“暂无”或合理推测但标注
                - 语言亲切、自然，像在和同事聊天
                - 控制总长度适中，便于企业微信阅读
                - 不要输出标题以外的任何 Markdown 层级标题（不要用 ## 或 ###）
                - 直接从“森兰今日天气预报”开始输出
                """

    chat_url = f"{LLM_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {LLM_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.5,
        "max_tokens": 2000,
    }

    try:
        print(f"🔄 正在调用阿里云百炼生成天气报告...")
        response = requests.post(chat_url, headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        result = response.json()
        content = (result.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
        if not content or len(content) < 30:
            return f"⚠️ **天气数据异常**：未生成有效报告，请稍后重试。\n\n当前时间：{get_current_time()}"
        print("✅ 阿里云百炼返回成功")
        return content
    except Exception as e:
        print(f"❌ 阿里云百炼调用失败: {e}")
        return f"⚠️ 大模型服务暂时不可用，请稍后再试。\n\n当前时间：{get_current_time()}"


def send_to_wechat(message):
    """发送消息到企业微信群机器人"""
    if not message:
        print("❌ 消息内容为空，取消发送")
        return False
    if not WECHAT_WEBHOOK_BASE_URL or not WEATHER_KEY:
        print("❌ 未配置 WECHAT_WEBHOOK_BASE_URL 或 WEATHER_KEY")
        return False

    try:
        if MENTION_ALL:
            wechat_message = {
                "msgtype": "text",
                "text": {"content": message, "mentioned_list": ["@all"]},
            }
        else:
            wechat_message = {"msgtype": "markdown", "markdown": {"content": message}}

        headers = {"Content-Type": "application/json"}
        response = requests.post(
            f"{WECHAT_WEBHOOK_BASE_URL}?key={WEATHER_KEY}",
            headers=headers,
            data=json.dumps(wechat_message, ensure_ascii=False).encode("utf-8"),
            timeout=10,
        )
        response.raise_for_status()
        result = response.json()
        if result.get("errcode") == 0:
            print(f"✅ 企业微信消息发送成功: {get_current_time()}")
            return True
        print(f"❌ 企业微信发送失败: {result}")
        return False
    except Exception as e:
        print(f"❌ 发送消息异常: {e}")
        return False


def main():
    print("=" * 50)
    print("🚀 企业微信天气机器人（阿里云百炼 + 高德天气）")
    print(f"🕐 当前时间: {get_current_time()}")
    print(f"📍 目标城市: {CITY}")
    print(f"👥 @所有人: {'开启' if MENTION_ALL else '关闭'}")
    print("=" * 50)

    weather_message = get_weather_from_llm()
    if not weather_message:
        print("❌ 获取天气报告失败，程序退出")
        sys.exit(1)

    if not weather_message.startswith("#"):
        weather_message = f"## 🌤️ 森兰今日天气报告\n\n{weather_message}"

    print("\n📤 正在发送到企业微信群...")

    if DEBUGGER_WEATHER:
        print(weather_message)
        success = True
    else:
        success = send_to_wechat(weather_message)

    if success:
        print("\n🎉 任务执行成功！")
        sys.exit(0)
    else:
        print("\n💥 任务执行失败")
        sys.exit(1)


if __name__ == "__main__":
    main()
