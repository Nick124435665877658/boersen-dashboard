const ALLOWED_ORIGIN = "https://nick124435665877658.github.io";
const CACHE_SECONDS = 15 * 60;
function cors(origin) {
 return {"Access-Control-Allow-Origin":origin===ALLOWED_ORIGIN?ALLOWED_ORIGIN:"null","Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Vary":"Origin"};
}
function json(data,status,origin) {
 return new Response(JSON.stringify(data),{status:status||200,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"public, max-age=60",...cors(origin)}});
}
function decodeXml(value) {
 return (value||"").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
}
function tag(xml,name) {
 const m=xml.match(new RegExp("<"+name+"(?:\\s[^>]*)?>([\\s\\S]*?)</"+name+">","i"));
 return m?decodeXml(m[1]).trim():"";
}
function parseFeed(xml) {
 const items=[];
 for(const match of xml.matchAll(/<item[^>]*>([\\s\\S]*?)<\\/item>/gi)){
  const item=match[1],title=tag(item,"title"),url=tag(item,"link"),date=tag(item,"pubDate");
  const publisher=tag(item,"source")||"Google News";
  if(title&&url)items.push({title,url,publisher,publishedAt:date&&!isNaN(Date.parse(date))?new Date(date).toISOString():null});
 }
 return items;
}
export default {
 async fetch(request) {
  const origin=request.headers.get("Origin")||"";
  if(request.method==="OPTIONS")return new Response(null,{headers:cors(origin)});
  if(origin!==ALLOWED_ORIGIN)return json({error:"Origin not allowed"},403,origin);
  const url=new URL(request.url);
  if(url.pathname!=="/api/news"||request.method!=="GET")return json({error:"Not found"},404,origin);
  const name=(url.searchParams.get("name")||"").trim().slice(0,90);
  const symbol=(url.searchParams.get("symbol")||"").trim().slice(0,30);
  if(!name)return json({error:"Unternehmensname fehlt."},400,origin);
  const cacheKey=new Request("https://rss-cache.local/"+encodeURIComponent((symbol||name).toUpperCase()));
  const cache=caches.default,cached=await cache.match(cacheKey);
  if(cached)return new Response(cached.body,{headers:{...Object.fromEntries(cached.headers),...cors(origin)}});
  const query='"'+name.replace(/"/g," ")+'" when:7d';
  const feeds=[
   "https://news.google.com/rss/search?q="+encodeURIComponent(query)+"&hl=de&gl=DE&ceid=DE:de",
   "https://news.google.com/rss/search?q="+encodeURIComponent(query)+"&hl=en-US&gl=US&ceid=US:en"
  ];
  try{
   const responses=await Promise.all(feeds.map(feed=>fetch(feed,{headers:{"User-Agent":"Mozilla/5.0 (compatible; BoersenDashboard/1.0)"},cf:{cacheTtl:CACHE_SECONDS,cacheEverything:true}})));
   const xmls=await Promise.all(responses.map(async r=>{if(!r.ok)throw new Error("Nachrichtenquelle antwortet mit HTTP "+r.status);return r.text();}));
   const unique=new Map();
   xmls.flatMap(parseFeed).forEach(article=>{const key=article.title.toLocaleLowerCase();if(!unique.has(key))unique.set(key,article);});
   const articles=[...unique.values()].sort((a,b)=>new Date(b.publishedAt||0)-new Date(a.publishedAt||0)).slice(0,14);
   const result={articles,fetchedAt:new Date().toISOString(),source:"Google News RSS"};
   const response=json(result,200,origin);
   await cache.put(cacheKey,new Response(response.clone().body,{headers:{"Content-Type":"application/json; charset=utf-8"}}));
   return response;
  }catch(error){return json({error:"RSS-Nachrichten konnten nicht geladen werden: "+error.message},502,origin);}
 }
};