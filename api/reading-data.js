// 위치: api/reading-data.js
const NOTION_VERSION = "2026-03-11";
const API = "https://api.notion.com/v1";

function normalizeNotionId(rawId = "") {
  const cleaned = String(rawId).trim().split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() || "";
  const match = cleaned.replace(/-/g, "").match(/[0-9a-f]{32}(?![0-9a-f])/i);
  return match ? match[0].toLowerCase() : "";
}

async function notion(path, token, body) {
  const response = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Notion API ${response.status}: ${text}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// 데이터베이스 ID → 데이터 소스 ID (2025-09-03 이후 방식)
async function resolveDataSourceId(databaseId, token) {
  const database = await notion(`/databases/${databaseId}`, token);
  const sources = database.data_sources || [];
  const source = sources.find(s => s.name === "Reading Library") || sources[0];
  if (!source) throw new Error("데이터베이스에서 데이터 소스를 찾지 못했습니다.");
  return source.id;
}

async function queryAllRows(dataSourceId, token) {
  const results = [];
  let cursor;
  do {
    const data = await notion(`/data_sources/${dataSourceId}/query`, token, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    });
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

const plain = list => (list || []).map(t => t.plain_text).join("");

function getText(prop) {
  if (prop?.type === "title") return plain(prop.title);
  if (prop?.type === "rich_text") return plain(prop.rich_text);
  return "";
}

function getOption(prop) {
  if (prop?.type === "select") return prop.select?.name || "";
  if (prop?.type === "status") return prop.status?.name || "";
  return "";
}

function getCover(prop) {
  for (const f of prop?.files || []) {
    const url = f.file?.url || f.external?.url;
    if (url) return url;
  }
  return "";
}

function mapBook(page) {
  const p = page.properties || {};
  const titleProp = Object.values(p).find(v => v?.type === "title");
  const date = p.Date?.date;
  return {
    id: page.id,
    title: getText(titleProp).trim(),
    author: getText(p.Author),
    pages: p.TotalPages?.number || 0,
    status: getOption(p.Status), // 비어 있으면 완독으로 세지 않음
    genre: getOption(p.Genre),
    rating: getOption(p.Rating),
    memo: getText(p["독서 메모"]),
    quoteCount: p.Quotes?.relation?.length || 0,
    quoteHasMore: Boolean(p.Quotes?.has_more),
    dateStart: (date?.start || "").slice(0, 10),
    dateEnd: (date?.end || "").slice(0, 10),
    cover: getCover(p.Files)
  };
}

function explain(error) {
  if (error.status === 401) return "노션 토큰이 올바르지 않습니다. NOTION_TOKEN을 확인하세요.";
  if (error.status === 403) return "노션 통합에 '콘텐츠 읽기' 권한이 있는지 확인하세요.";
  if (error.status === 404) return "DB를 찾지 못했습니다. NOTION_BOOKS_DB_ID와 DB의 통합 연결을 확인하세요.";
  if (error.status === 429) return "노션 요청이 많습니다. 잠시 후 다시 시도하세요.";
  return "노션 데이터를 불러오지 못했습니다. Vercel의 Logs를 확인하세요.";
}

export default async function handler(req, res) {
  // 새로고침할 때마다 최신 데이터를 받도록 캐시를 끔
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const token = (process.env.NOTION_TOKEN || "").trim();
  const databaseId = normalizeNotionId(process.env.NOTION_BOOKS_DB_ID);

  if (!token || !databaseId) {
    return res.status(500).json({
      error: "환경 변수 NOTION_TOKEN 또는 NOTION_BOOKS_DB_ID가 없거나 형식이 잘못되었습니다."
    });
  }

  try {
    const dataSourceId = await resolveDataSourceId(databaseId, token);
    const rows = await queryAllRows(dataSourceId, token);
    return res.status(200).json({
      books: rows.map(mapBook).filter(b => b.title),
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: explain(error), code: error.status || null });
  }
}
