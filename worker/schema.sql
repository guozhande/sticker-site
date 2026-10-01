-- 用户上传的表情包元数据
-- 图片字节存 R2，这里只存索引信息
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,              -- UUID
  r2_key     TEXT NOT NULL,                 -- R2 对象键
  filename   TEXT NOT NULL,                 -- 原始文件名
  mime       TEXT NOT NULL,                 -- image/gif | image/jpeg | image/png ...
  size       INTEGER NOT NULL,              -- 字节数
  work       TEXT NOT NULL,                 -- 作品名（用户输入，对应网站的二级/三级标签）
  characters TEXT NOT NULL DEFAULT '[]',    -- 角色名，JSON 数组；非单角色时多个
  created_at INTEGER NOT NULL,              -- 毫秒时间戳
  ip_hash    TEXT,                          -- 上传者 IP 的哈希（不存明文；投诉追溯用）
  status     TEXT NOT NULL DEFAULT 'visible' -- visible / hidden（侵权投诉下架）
);

CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_status  ON uploads(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_work    ON uploads(work);
