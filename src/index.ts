// הגדרת ממשקים עבור Cloudflare Worker ומשתני הסביבה
interface CloudflareKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

interface Env {
  DATABASE?: CloudflareKV;
  AI: any;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_GROUP_ID?: string;
  YOUTUBE_API_KEY: string;
  OPENROUTER_API_KEY?: string;
}

interface MoviRequest {
  chatId?: string;
  tempMsgId?: number;
}

interface YouTubeVideoItem {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: CloudflareExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const { chatId, tempMsgId } = await request.json() as MoviRequest;

      ctx.waitUntil(processAndSendYouTubeVideo(env, chatId, tempMsgId));

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Movi Worker Fetch Error:", errMsg);
      return new Response(`Movi Error: ${errMsg}`, { status: 500 });
    }
  },

  async scheduled(event: any, env: Env, ctx: CloudflareExecutionContext): Promise<void> {
    console.log("Cron Trigger fired for Movi Worker:", event.cron);
    const targetGroupId = env.TELEGRAM_GROUP_ID;

    if (!targetGroupId) {
      console.error("Cron Trigger aborted: TELEGRAM_GROUP_ID is not configured.");
      return;
    }

    ctx.waitUntil(processAndSendYouTubeVideo(env, targetGroupId));
  }
};

async function processAndSendYouTubeVideo(env: Env, requestChatId?: string, tempMsgId?: number): Promise<void> {
  const targetGroupId = env.TELEGRAM_GROUP_ID;

  try {
    console.log("Fetching YouTube videos from the last 24 hours...");
    const allVideos = await fetchYouTubeVideos(env);

    if (allVideos.length === 0) {
      const noVideoMsg = "⚠️ ששון לא מצא סרטונים חדשים מ-24 השעות האחרונות בנושא 'נ נח נחמ נחמן מאומן'.";
      if (targetGroupId && requestChatId && requestChatId !== targetGroupId) {
        if (tempMsgId) await sendTelegramVideo(env, requestChatId, noVideoMsg, tempMsgId);
        await sendTelegramVideo(env, targetGroupId, noVideoMsg);
      } else {
        await sendTelegramVideo(env, requestChatId || targetGroupId!, noVideoMsg, tempMsgId);
      }
      return;
    }

    // א. קריאת היסטוריית 3 הסרטונים האחרונים מ-KV
    let sentVideoIds: string[] = [];
    if (env.DATABASE) {
      try {
        const rawHistory = await env.DATABASE.get("movi_recent_videos");
        if (rawHistory) {
          sentVideoIds = JSON.parse(rawHistory);
        }
      } catch (e) {
        console.warn("Failed to read sent videos history from KV:", e);
      }
    }

    // ב. סינון החוצה של 3 הסרטונים האחרונים
    const freshVideos = allVideos.filter(v => !sentVideoIds.includes(v.videoId));
    const availableVideos = freshVideos.length > 0 ? freshVideos : allVideos;

    // ג. בחירת הסרטון ב-AI
    let selectedVideo = availableVideos[0];
    let aiReason = "נבחר כסרטון העדכני והחדש ביותר מ-24 השעות האחרונות.";

    try {
      const aiDecision = await selectBestVideoWithAI(availableVideos, env);
      if (aiDecision && aiDecision.videoId) {
        const found = availableVideos.find(v => v.videoId === aiDecision.videoId);
        if (found) selectedVideo = found;
        if (aiDecision.reason) aiReason = aiDecision.reason;
      }
    } catch (aiErr) {
      console.warn("AI filtering failed, falling back to top available video:", aiErr);
    }

    // ד. ניתוב חכם לקבוצה
    const videoUrl = `https://www.youtube.com/watch?v=${selectedVideo.videoId}`;
    const textMessage = `🎬 *סרטון נ נח יומי עבור כבוד הרב:*\n\n` +
                        `🎥 *${selectedVideo.title}*\n` +
                        `👤 *ערוץ:* ${selectedVideo.channelTitle}\n` +
                        `💡 *מדוע נבחר:* ${aiReason}\n\n` +
                        `${videoUrl}`;

    if (targetGroupId && requestChatId && requestChatId !== targetGroupId) {
      // עדכון בצ'אט הפרטי
      if (tempMsgId) {
        await sendTelegramVideo(env, requestChatId, "🎬 הסרטון היומי נאסף ונשלח כעת לקבוצה של כבוד הרב!", tempMsgId);
      }
      // שליחת הסרטון המלא לקבוצה
      await sendTelegramVideo(env, targetGroupId, textMessage, undefined, videoUrl);
    } else {
      await sendTelegramVideo(env, requestChatId || targetGroupId!, textMessage, tempMsgId, videoUrl);
    }

    // ה. עדכון ה-KV
    if (env.DATABASE && selectedVideo?.videoId) {
      try {
        const updatedHistory = [selectedVideo.videoId, ...sentVideoIds.filter(id => id !== selectedVideo.videoId)].slice(0, 3);
        await env.DATABASE.put("movi_recent_videos", JSON.stringify(updatedHistory));
      } catch (e) {
        console.warn("Failed to update sent videos history in KV:", e);
      }
    }

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("Error in processAndSendYouTubeVideo:", errMsg);
    if (requestChatId) {
      try {
        await sendTelegramVideo(env, requestChatId, `⚠️ ששון נתקל בשגיאה בעת הבאת הסרטון: ${errMsg}`, tempMsgId);
      } catch {}
    }
  }
}

async function fetchYouTubeVideos(env: Env): Promise<YouTubeVideoItem[]> {
  if (!env.YOUTUBE_API_KEY) {
    throw new Error("YOUTUBE_API_KEY is missing in environment variables.");
  }

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = encodeURIComponent("נ נח נחמ נחמן מאומן");

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${query}&type=video&order=date&publishedAfter=${twentyFourHoursAgo}&maxResults=10&key=${env.YOUTUBE_API_KEY}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`YouTube API returned status ${response.status}: ${errText}`);
  }

  const data = await response.json() as any;
  const items = data.items || [];

  return items.map((item: any) => ({
    videoId: item.id?.videoId || "",
    title: item.snippet?.title || "",
    description: item.snippet?.description || "",
    channelTitle: item.snippet?.channelTitle || "",
    publishedAt: item.snippet?.publishedAt || ""
  })).filter((v: YouTubeVideoItem) => v.videoId.length > 0);
}

async function selectBestVideoWithAI(videos: YouTubeVideoItem[], env: Env): Promise<{ videoId: string; reason: string } | null> {
  const systemPrompt = "שמך ששון, מסנן סרטוני יוטיוב מדויק. תפקידך לנתח את רשימת הסרטונים הבאה מ-24 השעות האחרונות בנושא 'נ נח נחמ נחמן מאומן', ולבחור את הסרטון האיכותי, המעורר והמתאים ביותר. השב אך ורק בפורמט JSON תקין ללא שום טקסט נוסף או מארקדאון במבנה: {\"videoId\": \"ID_HERE\", \"reason\": \"נימוק קצר בעברית\"}";
  
  const userContent = JSON.stringify(videos.map(v => ({
    videoId: v.videoId,
    title: v.title,
    description: v.description,
    channel: v.channelTitle
  })));

  let rawAiOutput = "";

  try {
    if (env.OPENROUTER_API_KEY) {
      const openRouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://workers.cloudflare.com",
          "X-Title": "Sasson Movi Agent"
        },
        body: JSON.stringify({
          model: "google/gemma-2-9b-it:free",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
          ],
          temperature: 0.2,
          max_tokens: 300
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (openRouterRes.ok) {
        const resJson = await openRouterRes.json() as any;
        rawAiOutput = resJson?.choices?.[0]?.message?.content || "";
      }
    }
  } catch (e) {
    console.warn("OpenRouter Movi AI failed, trying Cloudflare Workers AI fallback...", e);
  }

  if (!rawAiOutput && env.AI) {
    try {
      const cfRes = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ],
        max_tokens: 300
      });
      rawAiOutput = cfRes.response || "";
    } catch (e) {
      console.error("Cloudflare Workers AI fallback failed:", e);
    }
  }

  if (rawAiOutput) {
    try {
      const cleanJson = rawAiOutput.replace(/```json/g, "").replace(/```/g, "").trim();
      return JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error("Failed to parse AI JSON output:", parseErr);
    }
  }

  return null;
}

async function sendTelegramVideo(env: Env, chatId: string, text: string, messageId?: number, videoUrl?: string): Promise<any> {
  const method = messageId ? "editMessageText" : "sendMessage";
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

  const payload: any = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  };

  if (videoUrl) {
    payload.link_preview_options = {
      is_disabled: false,
      url: videoUrl,
      prefer_large_media: true
    };
  }

  if (messageId) {
    payload.message_id = messageId;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  const resJson = await res.json() as any;

  if (!resJson.ok && messageId) {
    return sendTelegramVideo(env, chatId, text, undefined, videoUrl);
  }

  return resJson;
}
