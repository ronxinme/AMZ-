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

### 在网页上直接增删改商品（推荐）

打开网页 → 顶部 **🗂 商品管理** 标签页 → 就能新增 / 编辑 / 删除商品，无需再动 GitHub。

第一次用需要填一次 **GitHub 令牌**（只存在你自己的浏览器里，不会上传到任何服务器）：

1. GitHub 右上头像 → **Settings** → 左下 **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. **Repository access** 选 `Only select repositories` → 勾选你这个仓库
3. **Permissions → Repository permissions**：
   - `Contents` → **Read and write**（读写 products.json）
   - `Actions` → **Read and write**（保存后自动触发一次采集）
4. 建议设置 **Expiration**（如 90 天），生成后复制 `github_pat_…` 开头的字符串
5. 回到网页「商品管理」页粘进输入框 → 保存令牌。之后可点「测试连接」确认通了

> 令牌等于把仓库的写入权限给了这个浏览器。请只在**你自己的设备**上保存，公用电脑上用完点「清除令牌」。担心安全也可以继续用老办法：直接在 GitHub 上编辑 `data/products.json`。

### 其他操作对照表

| 想做什么 | 怎么做 |
|---|---|
| 增删改跟踪的 ASIN | 网页「🗂 商品管理」页直接操作；或编辑仓库 `data/products.json`（自有商品 `type:"own"`，竞品 `type:"compete"` + `parentId` 指向自有商品 id） |
| 改采集时间 | 编辑 `.github/workflows/daily-collect.yml` 的 cron（UTC） |
| 手动补跑一次 | Actions 页 → Run workflow，或网页商品管理页保存时勾选「保存后立即采集」 |
| 看每次采集结果明细 | Actions 页点开对应那次运行，底部有完整结果表格 |
| 导出当天 CSV | 网页右上角按钮 |
| 查看某天跟另一天的对比 | 网页「📅 历史对比」页：左边固定「商品信息 + 指标名」，右边每列是一天的数值 |
| 修改访问口令 | 计算 `sha256(新口令)`（任意在线 SHA-256 工具），替换 `app.js` 顶部 `ACCESS_CODE_SHA256` 后提交 |
| 给商品设预期价格区间 | 商品管理页填「最低/最高预期价」，或直接改 `data/products.json` 的 `priceMin` / `priceMax`；采到区间外的价格时网页标 ⚠「价格异常」 |
| 核对价格来源 | 每条记录带 `priceSource`：`buybox_json`（买箱 Twister 数据，最可靠）/ `cart_form`（加购表单成交价）/ `apex_pricetopay_label`、`apex_pricetopay_value`（价格主区块）；`listPrice` 是划线价，`unitPrice` 是每件单价（如 `$9.50/count`），**单价永远不会被当成售价** |

## 售价是怎么取的（避免踩坑）

亚马逊商品页里同一个页面会有很多价格数字：主价、划线价、**每件单价**、搭配购、推荐位、其他卖家报价……

本工具的取价优先级（从高到低）：

1. `twister-plus-buying-options-price-data` 买箱 JSON —— 只含当前选中变体的成交价
2. 加购表单里的 `customerVisiblePrice` —— 顾客实际支付价
3. 价格主区块的 `priceToPay`（价签 / 无障碍标签）
4. 全局 JSON 兜底 `priceAmount` / `displayPrice`

**关键点：绝不取裸 `a-offscreen`。** 曾经踩过的坑——页面里 `priceToPay` 的 `a-offscreen` 是空的，紧随其后的第一个非空 `a-offscreen` 其实是「每件单价」：4 件装 $37.99 会被误读成 $9.50（= 37.99 ÷ 4）。现在单价单独存到 `unitPrice`，只作参考。

若某商品当天取不到价（页面显示「Available from these sellers」没有主报价），价格记为空并在历史表里显示 `—`，不会瞎猜。


## 验证码问题（重要，如实说明）

GitHub Actions 的出口 IP 是数据中心 IP，亚马逊可能弹验证码；遇到时该商品当天标记为「验证码」，**不会造数**，第二天自动重试。想提高成功率有两个免费手段（在仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加）：

| Secret 名 | 填什么 | 效果 |
|---|---|---|
| `SCRAPER_MODE` | `jina` | 走 r.jina.ai 免费通道（无需 Key），成功率更高但页面格式略有差异 |
| `SCRAPER_MODE` + `SCRAPER_KEY` | `scrapingbee` + 免费注册拿 Key（每月 1000 次免费） | 住宅代理，成功率最高；200 ASIN × 30 天约 6000 次/月，超出免费额度，适合商品数 ≤ 100 的阶段 |

## 关于「库存数量」的实话

你可能见过卖家精灵插件里那个「剩余库存 100」。**那个数字不是从亚马逊页面上读出来的**，而是插件去调卖家精灵自己服务器的接口，数字来自他们花钱养住宅代理池、大规模抓取后攒起来的数据库（属他们的付费数据资产）。

所以有两条路：

| 路线 | 说明 | 成本 |
|---|---|---|
| 卖家精灵**官方开放 API** | `api.sellersprite.com`，secret-key 认证，有 ASIN 详情 / 销量估算 / BSR 估算等接口；他们还有官方 MCP 服务（`open.sellersprite.com/mcp`）。这才是把那份数据接进你自己工具的正路 | 按量付费 |
| 只看亚马逊官方公开的信号 | 本工具已经做到，见下 | 免费 |

**亚马逊官方页面上到底有什么（免费可读）**：

- `Only N left in stock - order soon.` —— 亚马逊**主动**显示的仅剩数量，出现在「availability」区块。**只有库存偏低时它才会显示**，库存充足的商品只写 `In Stock`，没有数字。
- `In Stock` / `Currently unavailable` —— 有货 / 缺货，一定读得到
- `limit N per customer` —— 限购数量
- 过去一个月已购买 N+ —— 动销信号，比库存更能反映卖得好不好
- BSR（大类 / 小类）—— 排名，最稳定的竞争强度指标

**本工具已做的两个修正**（2026-09-24）：

1. 修掉一个真 bug：以前用页面里第一个 `add-to-cart-button` 当锚点找库存，但那个位置其实是**导航栏的键盘快捷键面板**（"Add to cart shift+alt+K"），真正的加购按钮在 16 万字符之后 —— 等于一直在菜单里找库存。现在改成锚定真实的买箱容器 `#desktop_buybox` / `#qualifiedBuybox` + `#availability`。
2. 以前全文搜索「Only N left in stock」会误取页面下方「看过还看了」推荐轮播里**邻居商品**的库存。现在限定只在上面两块官方区域内匹配，并额外记录一字段 `availabilityText`（亚马逊原话），页面上的库存格悬浮就能看到。

**加购 999 探针已确认失效**：2026-09 实测，本机住宅 IP 和云端数据中心 IP 都返回 `Your Amazon Cart is empty`，亚马逊已封掉匿名会话的加购通道。代码保留但默认关闭（`STOCK_PROBE=1` 才尝试）。

**结论**：想免费拿到*精确*的竞品库存数字，目前没有可靠办法。能免费拿到的、而且更有决策价值的是「**断货监控**」——本工具的「当天数据」页现在会提示库存状态变化（有货 → 缺货 / 仅剩 N 件），竞品断货就是你的机会窗口，这比一个静态库存数字有用得多。

## 与其他版本的差别（如实说明）

- 具体库存数量：见上一节。库存列是状态口径：`仅剩 N 件`（亚马逊原话）/ `有货，数量未显示` / `缺货` / `未知`
- 网页是公开地址 + 口令门（防误入，非加密）。若介意，可改用私有仓库跑采集（每月 2000 分钟免费额度，本工具每天约 30 分钟，够用）
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
