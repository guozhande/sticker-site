// Cloudflare Worker - 表情包存储站上传 API
// 部署命令: npx wrangler deploy

// 原始内置表情包数据（和 stickers.json 同步）
const BUILTIN_STICKERS = [
  {"id":"genshin-paimon","filename":"genshin-paimon.gif","url":"stickers/genshin-paimon.gif","tags":["派蒙","原神","应急食品"],"category":"原神"},
  {"id":"genshin-hutao","filename":"genshin-hutao.gif","url":"stickers/genshin-hutao.gif","tags":["胡桃","原神","往生堂"],"category":"原神"},
  {"id":"genshin-zhongli","filename":"genshin-zhongli.gif","url":"stickers/genshin-zhongli.gif","tags":["钟离","原神","岩王帝君"],"category":"原神"},
  {"id":"genshin-raiden","filename":"genshin-raiden.gif","url":"stickers/genshin-raiden.gif","tags":["雷电将军","原神","雷神"],"category":"原神"},
  {"id":"genshin-venti","filename":"genshin-venti.gif","url":"stickers/genshin-venti.gif","tags":["温迪","原神","风神"],"category":"原神"},
  {"id":"genshin-nahida","filename":"genshin-nahida.gif","url":"stickers/genshin-nahida.gif","tags":["纳西妲","原神","草神"],"category":"原神"},
  {"id":"genshin-xiao","filename":"genshin-xiao.gif","url":"stickers/genshin-xiao.gif","tags":["魈","原神","降魔大圣"],"category":"原神"},
  {"id":"genshin-ganyu","filename":"genshin-ganyu.gif","url":"stickers/genshin-ganyu.gif","tags":["甘雨","原神","椰羊"],"category":"原神"},
  {"id":"genshin-furina","filename":"genshin-furina.gif","url":"stickers/genshin-furina.gif","tags":["芙宁娜","原神","水神"],"category":"原神"},
  {"id":"genshin-yelan","filename":"genshin-yelan.gif","url":"stickers/genshin-yelan.gif","tags":["夜兰","原神","兰姐"],"category":"原神"},
  {"id":"hsr-firefly","filename":"hsr-firefly.gif","url":"stickers/hsr-firefly.gif","tags":["流萤","星穹铁道","萨姆"],"category":"崩坏星穹铁道"},
  {"id":"hsr-kafka","filename":"hsr-kafka.gif","url":"stickers/hsr-kafka.gif","tags":["卡芙卡","星穹铁道","星核猎手"],"category":"崩坏星穹铁道"},
  {"id":"hsr-jingliu","filename":"hsr-jingliu.gif","url":"stickers/hsr-jingliu.gif","tags":["镜流","星穹铁道","前代罗刹"],"category":"崩坏星穹铁道"},
  {"id":"hsr-silverwolf","filename":"hsr-silverwolf.gif","url":"stickers/hsr-silverwolf.gif","tags":["银狼","星穹铁道","骇客"],"category":"崩坏星穹铁道"},
  {"id":"honkai-kiana","filename":"honkai-kiana.gif","url":"stickers/honkai-kiana.gif","tags":["琪亚娜","崩坏3","草履虫"],"category":"崩坏3"},
  {"id":"honkai-seele","filename":"honkai-seele.gif","url":"stickers/honkai-seele.gif","tags":["希儿","崩坏3","量子"],"category":"崩坏3"},
  {"id":"honkai-fuhua","filename":"honkai-fuhua.gif","url":"stickers/honkai-fuhua.gif","tags":["符华","崩坏3","仙人"],"category":"崩坏3"},
  {"id":"zzz-nicole","filename":"zzz-nicole.gif","url":"stickers/zzz-nicole.gif","tags":["妮可","绝区零","狡兔屋"],"category":"绝区零"},
  {"id":"zzz-anby","filename":"zzz-anby.gif","url":"stickers/zzz-anby.gif","tags":["安比","绝区零","冷静"],"category":"绝区零"},
  {"id":"wuwa-jinhsi","filename":"wuwa-jinhsi.gif","url":"stickers/wuwa-jinhsi.gif","tags":["今汐","鸣潮","今州"],"category":"鸣潮"},
  {"id":"wuwa-changli","filename":"wuwa-changli.gif","url":"stickers/wuwa-changli.gif","tags":["长离","鸣潮","凤凰"],"category":"鸣潮"},
  {"id":"wuwa-camellya","filename":"wuwa-camellya.gif","url":"stickers/wuwa-camellya.gif","tags":["椿","鸣潮","彼岸花"],"category":"鸣潮"},
  {"id":"cat-kiss","filename":"cat-kiss.gif","url":"stickers/cat-kiss.gif","tags":["猫","亲亲","爱心","可爱"],"category":"沙雕"},
  {"id":"facepalm","filename":"facepalm.gif","url":"stickers/facepalm.gif","tags":["无语","扶额","尴尬","脸疼"],"category":"沙雕"},
  {"id":"party","filename":"party.gif","url":"stickers/party.gif","tags":["庆祝","嗨","派对","开心"],"category":"沙雕"}
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /data/stickers.json 由 Cloudflare Pages 直接提供静态文件
    // /api/user-stickers.json 返回用户上传的表情包（用于 App 合并）
    if (url.pathname === '/api/user-stickers.json' && request.method === 'GET') {
      let userStickers = [];
      try {
        const list = await env.MY_BUCKET.get('user-stickers.json');
        if (list) userStickers = JSON.parse(await list.text());
      } catch (e) {}
      return json(userStickers, 200);
    }

    // POST /api/upload — 用户上传表情包
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        const tags = formData.get('tags') || '用户上传';
        const category = formData.get('category') || '用户上传';

        if (!file || !file.name) {
          return json({ error: '请上传文件' }, 400);
        }

        const filename = `uploads/${Date.now()}-${file.name}`;

        // 存图片到 R2
        await env.MY_BUCKET.put(filename, file.stream(), {
          httpMetadata: { contentType: file.type || 'image/gif' }
        });

        // 更新用户上传列表
        let userStickers = [];
        try {
          const existing = await env.MY_BUCKET.get('user-stickers.json');
          if (existing) userStickers = JSON.parse(await existing.text());
        } catch (e) {}

        const sticker = {
          id: `user-${Date.now()}`,
          filename: file.name,
          url: filename,
          tags: tags.split(',').map(t => t.trim()),
          category: category
        };
        userStickers.push(sticker);
        await env.MY_BUCKET.put('user-stickers.json', JSON.stringify(userStickers));

        return json({ success: true, sticker }, 200);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // 其他请求代理到 Pages
    return env.ASSETS.fetch(request);
  }
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
