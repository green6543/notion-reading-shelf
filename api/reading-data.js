const NOTION_VERSION = "2026-03-11";

function normalizeNotionId(rawId = "") {
  const cleaned = String(rawId).trim().split("?")[0].split("/").pop() || "";
  const hexOnly = cleaned.replace(/-/g, "");
  const match = hexOnly.match(/[0-9a-fA-F]{32}/);
  return match ? match[0].toLowerCase() : "";
}

async function queryAllNotionRows(databaseId, notionToken) {
  const results = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        page_size: 100,
        start_cursor: startCursor
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Notion query failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    results.push(...(data.results || []));
    hasMore = Boolean(data.has_more);
    startCursor = data.next_cursor || undefined;
  }

  return results;
}

function getTextValue(prop) {
  if (!prop) return "";
  if (prop.type === "title") return (prop.title || []).map(t => t.plain_text).join("");
  if (prop.type === "rich_text") return (prop.rich_text || []).map(t => t.plain_text).join("");
  if (prop.type === "formula") {
    if (prop.formula?.type === "string") return prop.formula.string || "";
    if (prop.formula?.type === "number") return String(prop.formula.number ?? "");
  }
  if (prop.type === "rollup") {
    const arr = prop.rollup?.array || [];
    return arr.map(item => getTextValue(item)).filter(Boolean).join(", ");
  }
  return "";
}

function getNumberValue(prop) {
  if (!prop) return 0;
  if (prop.type === "number") return Number(prop.number ?? 0);
  if (prop.type === "formula" && prop.formula?.type === "number") return Number(prop.formula.number ?? 0);
  return 0;
}

function getSelectOrStatusName(prop, fallback = "") {
  if (!prop) return fallback;
  if (prop.type === "select") return prop.select?.name || fallback;
  if (prop.type === "status") return prop.status?.name || fallback;
  return fallback;
}

function getFilesArray(prop) {
  if (!prop || prop.type !== "files" || !Array.isArray(prop.files)) return [];
  return prop.files
    .map(f => {
      if (f.type === "file" && f.file?.url) {
        return { type: "file", url: f.file.url, name: f.name || "" };
      }
      if (f.type === "external" && f.external?.url) {
        return { type: "external", url: f.external.url, name: f.name || "" };
      }
      return null;
    })
    .filter(Boolean);
}

function getSingleDateRange(prop) {
  if (!prop || prop.type !== "date" || !prop.date) {
    return { start: "", end: "" };
  }
  const start = (prop.date.start || "").slice(0, 10);
  const end = (prop.date.end || prop.date.start || "").slice(0, 10);
  return { start, end };
}

function mapBookPage(page) {
  const p = page.properties || {};
  const titleProp = Object.values(p).find(item => item && item.type === "title");
  const dateProp =
    p["Date"] ||
    p["date"] ||
    p["날짜"] ||
    Object.values(p).find(item => item && item.type === "date");
  const filesProp =
    p["파일 및 미디어"] ||
    p["Files"] ||
    p["files"] ||
    p["SpineImage"] ||
    p["Cover"] ||
    Object.values(p).find(item => item && item.type === "files");

  const dateRange = getSingleDateRange(dateProp);
  const files = getFilesArray(filesProp);

  return {
    id: page.id,
    Title: getTextValue(p["Title"] || p["도서명"] || p["이름"] || titleProp),
    Author: getTextValue(p["Author"] || p["저자"]),
    TotalPages: getNumberValue(p["TotalPages"] || p["총 페이지"]),
    Status: getSelectOrStatusName(p["Status"] || p["독서 상태"], "완독"),
    Genre: getSelectOrStatusName(p["Genre"] || p["장르"], "기타"),
    Date: dateRange,
    StartDate: dateRange.start,
    FinishedDate: dateRange.end,
    Files: files,
    SpineImage: files[0]?.url || "",
    SpineColor: getSelectOrStatusName(p["SpineColor"] || p["책등 색상"], "#5c6f82")
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { NOTION_TOKEN, NOTION_BOOKS_DB_ID } = process.env;
  const booksDbId = normalizeNotionId(NOTION_BOOKS_DB_ID);

  if (!NOTION_TOKEN || !booksDbId) {
    return res.status(500).json({
      error: "NOTION_TOKEN 또는 NOTION_BOOKS_DB_ID 환경 변수가 없거나 형식이 올바르지 않습니다."
    });
  }

  try {
    const bookRows = await queryAllNotionRows(booksDbId, NOTION_TOKEN);
    const books = bookRows.map(mapBookPage).filter(b => b.Title);

    return res.status(200).json({
      books,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to load reading data" });
  }
}