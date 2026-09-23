# 亚马逊每日竞品记录工具 · GitHub 免费版

不租服务器、不花一分钱的云端方案：**GitHub Actions 每天定时采集 → 数据自动存进仓库 → GitHub Pages 免费托管网页**，任何设备打开链接就能看。

## 上线只需 4 步（约 10 分钟）

### 第 1 步：注册 GitHub（免费）
https://github.com/signup

### 第 2 步：创建仓库并上传本文件夹的全部内容
1. 登录后点右上角 **+ → New repository**
2. 仓库名随意（如 `amazon-tracker`），选 **Public**（公开仓库 Actions 分钟数不限），点 Create
3. 点 **uploading an existing file**，把本文件夹的**全部文件（含 .github 隐藏文件夹！）**拖进去，点 Commit changes
   - Windows 资源管理器需开启「显示隐藏项目」才能看到 `.github` 文件夹
   - 文件较多时建议用 GitHub Desktop（https://desktop.github.com）拖拽上传，更稳

### 第 3 步：开启 GitHub Pages（网页入口）
仓库 **Settings → Pages → Source 选 `Deploy from a branch` → Branch 选 `main` / `(root)` → Save**
约 1 分钟后，你的专属网址就是：
```
https://你的用户名.github.io/仓库名/
```
访问口令默认 `admin123`（修改方法见下文「改口令」）。

### 第 4 步：立即跑第一次采集
仓库页 **Actions → Amazon Daily Collect → Run workflow → Run** 。
之后每天北京时间 09:00 自动跑（可在 `.github/workflows/daily-collect.yml` 里改 cron，注意写的是 UTC 时间）。

## 日常使用

| 想做什么 | 怎么做 |
|---|---|
| 增删改跟踪的 ASIN | 编辑仓库里的 `data/products.json`（自有商品 `type:"own"`，竞品 `type:"compete"` + `parentId` 指向自有商品 id），保存即生效，下次采集生效 |
| 改采集时间 | 编辑 `.github/workflows/daily-collect.yml` 的 cron（UTC） |
| 手动补跑一次 | Actions 页 → Run workflow |
| 看每次采集结果明细 | Actions 页点开对应那次运行，底部有完整结果表格 |
| 导出当天 CSV | 网页右上角按钮 |
| 修改访问口令 | 计算 `sha256(新口令)`（任意在线 SHA-256 工具），替换 `app.js` 顶部 `ACCESS_CODE_SHA256` 后提交 |

## 验证码问题（重要，如实说明）

GitHub Actions 的出口 IP 是数据中心 IP，亚马逊可能弹验证码；遇到时该商品当天标记为「验证码」，**不会造数**，第二天自动重试。想提高成功率有两个免费手段（在仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加）：

| Secret 名 | 填什么 | 效果 |
|---|---|---|
| `SCRAPER_MODE` | `jina` | 走 r.jina.ai 免费通道（无需 Key），成功率更高但页面格式略有差异 |
| `SCRAPER_MODE` + `SCRAPER_KEY` | `scrapingbee` + 免费注册拿 Key（每月 1000 次免费） | 住宅代理，成功率最高；200 ASIN × 30 天约 6000 次/月，超出免费额度，适合商品数 ≤ 100 的阶段 |

## 与其他版本的差别（如实说明）

- 免费 GitHub 方案拿不到**卖家精灵扩展里显示的具体库存数量**（那是浏览器插件数据）。库存列为状态口径：`有货，数量未显示` / `不可购买` / `库存未获取`；页面出现 `Only N left` 或限购提示时会如实记录
- 网页是公开地址 + 口令门（防误入，非加密）。若介意，可改用私有仓库跑采集（每月 2000 分钟免费额度，本工具每天约 30 分钟，够用），把 `data/` 通过 Actions 推到你自己的另一个私有 Gist/仓库
- GitHub Actions 的定时在高峰期可能延迟几分钟到十几分钟，属正常现象

## 文件结构
```
├─ .github/workflows/daily-collect.yml   每日定时任务（改时间/开关都在这）
├─ scripts/collect.mjs                   采集脚本
├─ data/products.json                    商品清单（你要维护的唯一文件）
├─ data/history.json                     采集历史（自动生成，勿手改）
├─ data/summary.json                     上次运行摘要（自动生成）
├─ index.html / app.js / style.css       网页界面（Pages 直接托管）
```
