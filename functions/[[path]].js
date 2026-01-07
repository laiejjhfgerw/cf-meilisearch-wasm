// 引入 Meilisearch Wasm 核心库
import { MeiliSearch } from 'meilisearch-wasm';

// 全局变量：缓存 Meilisearch 实例（避免每次请求重新初始化）
let meiliInstance = null;
// 配置项（可在网页端直接修改）
const CONFIG = {
  INDEX_UID: "test_index",        // 索引名称
  API_KEY: "my_secure_key",       // 鉴权密钥（自定义，导入数据时验证）
  CACHE_TTL: 300,                 // 检索结果缓存时间（秒）
  BATCH_SIZE: 500                 // 单次导入最大条数（适配 15 秒时长限制）
};

/**
 * 初始化 Meilisearch Wasm 实例（从 KV 加载索引快照）
 */
async function initMeili(env) {
  if (meiliInstance) return meiliInstance;

  // 1. 初始化 Wasm 版 Meilisearch（内存存储模式）
  const meili = new MeiliSearch({
    env: 'web',  // 适配边缘/浏览器环境
    config: {
      databaseLocation: 'in-memory',  // 核心：Wasm 仅支持内存存储
      apiKey: CONFIG.API_KEY
    }
  });

  // 2. 从 KV 加载已保存的索引快照（避免重启丢失）
  const snapshotKey = `meili_snapshot_${CONFIG.INDEX_UID}`;
  const snapshotBase64 = await env.MEILI_KV.get(snapshotKey);
  if (snapshotBase64) {
    try {
      // Base64 转 Uint8Array（KV 仅存字符串，需转换）
      const snapshotBuffer = Uint8Array.from(
        atob(snapshotBase64), 
        c => c.charCodeAt(0)
      );
      // 导入索引快照
      await meili.importDatabase(snapshotBuffer);
      console.log("✅ 从 KV 加载索引成功");
    } catch (e) {
      console.error("❌ 加载索引失败，创建新索引：", e);
      // 加载失败则创建新索引
      await createNewIndex(meili);
    }
  } else {
    // 首次运行：创建新索引
    await createNewIndex(meili);
  }

  // 缓存实例，后续请求复用
  meiliInstance = meili;
  return meili;
}

/**
 * 创建新的 Meilisearch 索引（首次运行/索引加载失败时调用）
 */
async function createNewIndex(meili) {
  await meili.createIndex(CONFIG.INDEX_UID, {
    primaryKey: 'id',  // 主键字段（数据必须包含 id）
    settings: {
      searchableAttributes: ['content'],  // 仅检索 content 字段（节省内存）
      filterableAttributes: ['category'], // 可选过滤字段
      pagination: { maxTotalHits: 10000 } // 最大返回结果数（测试用）
    }
  });
  console.log("✅ 新建索引成功");
}

/**
 * 保存索引快照到 KV（数据导入后调用）
 */
async function saveSnapshot(env) {
  if (!meiliInstance) return;

  try {
    // 导出索引快照（Uint8Array 格式）
    const snapshotBuffer = await meiliInstance.exportDatabase();
    // 转 Base64 存储到 KV
    const snapshotBase64 = btoa(String.fromCharCode(...snapshotBuffer));
    await env.MEILI_KV.put(
      `meili_snapshot_${CONFIG.INDEX_UID}`,
      snapshotBase64,
      { expirationTtl: 0 }  // 永久存储
    );
    console.log("✅ 索引快照已保存到 KV");
  } catch (e) {
    console.error("❌ 保存快照失败：", e);
  }
}

/**
 * 处理跨域请求（必加，否则前端调用报错）
 */
function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

/**
 * 检索接口处理（GET/POST）
 */
async function handleSearch(request, env, ctx) {
  const url = new URL(request.url);
  const cache = caches.default;

  // 1. 解析查询参数
  let query = {};
  if (request.method === 'GET') {
    query = {
      q: url.searchParams.get('q') || '',
      page: parseInt(url.searchParams.get('page')) || 1,
      limit: parseInt(url.searchParams.get('limit')) || 10
    };
  } else {
    query = await request.json().catch(() => ({ q: '' }));
  }

  // 2. 构建缓存 Key（避免重复查询）
  const cacheKey = `search_${JSON.stringify(query)}`;
  const cachedRes = await cache.match(cacheKey);
  if (cachedRes) {
    // 缓存命中，直接返回
    const data = await cachedRes.json();
    return new Response(JSON.stringify(data), {
      headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  // 3. 缓存未命中，调用 Meilisearch 检索
  const meili = await initMeili(env);
  const index = meili.index(CONFIG.INDEX_UID);
  const result = await index.search(query.q, {
    page: query.page,
    limit: query.limit
  });

  // 4. 存入缓存
  const res = new Response(JSON.stringify(result), {
    headers: {
      ...getCorsHeaders(),
      'Content-Type': 'application/json',
      'Cache-Control': `s-maxage=${CONFIG.CACHE_TTL}`
    }
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));

  return res;
}

/**
 * 数据导入接口处理（仅 POST）
 */
async function handleImport(request, env) {
  // 1. 验证鉴权
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${CONFIG.API_KEY}`) {
    return new Response(JSON.stringify({ error: "鉴权失败" }), {
      status: 401,
      headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  // 2. 解析导入数据
  let data = [];
  try {
    data = await request.json();
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("数据必须是非空数组");
    }
    // 限制单次导入条数（避免超时）
    if (data.length > CONFIG.BATCH_SIZE) {
      return new Response(JSON.stringify({
        error: `单次导入最多 ${CONFIG.BATCH_SIZE} 条`
      }), {
        status: 400,
        headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: "数据格式错误：" + e.message }), {
      status: 400,
      headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  // 3. 初始化 Meilisearch 并导入数据
  const meili = await initMeili(env);
  const index = meili.index(CONFIG.INDEX_UID);
  try {
    await index.addDocuments(data);
    // 导入成功后保存索引快照到 KV
    await saveSnapshot(env);
    return new Response(JSON.stringify({
      success: true,
      imported: data.length,
      msg: "数据导入成功，索引已保存"
    }), {
      headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "导入失败：" + e.message }), {
      status: 500,
      headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 主请求处理函数（路由分发）
 */
export async function onRequest(context) {
  const { request, env, params } = context;
  const path = params.path?.join('/') || '';

  // 处理 OPTIONS 跨域预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: getCorsHeaders() });
  }

  // 路由分发
  switch (path) {
    case 'api/search':  // 检索接口
      return handleSearch(request, env, context);
    case 'api/import':  // 数据导入接口
      return handleImport(request, env);
    default:            // 默认路由
      return new Response(JSON.stringify({
        msg: "Meilisearch Wasm 部署成功",
        endpoints: {
          search: "GET/POST /api/search",
          import: "POST /api/import (需 Authorization 头)"
        }
      }), {
        headers: { ...getCorsHeaders(), 'Content-Type': 'application/json' }
      });
  }
}
