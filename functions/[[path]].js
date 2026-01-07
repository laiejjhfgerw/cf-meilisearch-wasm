// functions/api/[[path]].ts
import { MeiliSearch } from 'meilisearch-wasm';

// 全局缓存Meilisearch实例
let meilisearchInstance: MeiliSearch | null = null;

// 初始化Meilisearch WASM实例
async function initMeilisearch() {
  if (meilisearchInstance) return meilisearchInstance;
  
  // 加载WASM版Meilisearch
  meilisearchInstance = new MeiliSearch({
    env: 'development',
    config: {
      httpHeaders: {},
    },
  });
  
  // 从Cloudflare环境变量读取API密钥（避免硬编码）
  const apiKey = env.MEILI_API_KEY || 'default-test-key';
  meilisearchInstance.setApiKey(apiKey);
  
  return meilisearchInstance;
}

// 处理CORS跨域
const handleCors = (response: Response) => {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(response.body, { status: response.status, headers });
};

// 核心请求处理函数
export async function onRequest(context: any) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // 处理OPTIONS预检请求
  if (request.method === 'OPTIONS') {
    return handleCors(new Response(null, { status: 204 }));
  }

  try {
    // 初始化Meilisearch实例
    const ms = await initMeilisearch();
    
    // 提取请求路径（去掉/api前缀）
    const path = url.pathname.replace('/api', '') || '/';
    const msUrl = new URL(`http://meilisearch${path}${url.search}`);

    // 构建转发请求
    const msRequest = new Request(msUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' ? await request.arrayBuffer() : null,
    });

    // 转发请求到Meilisearch WASM
    const response = await ms.fetch(msRequest);
    return handleCors(new Response(response.body, {
      status: response.status,
      headers: response.headers,
    }));
  } catch (error) {
    return handleCors(new Response(JSON.stringify({
      error: (error as Error).message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
}
