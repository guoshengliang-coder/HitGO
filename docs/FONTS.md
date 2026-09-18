# 字体清单（HIG-66）

编辑器的「文字 → 字体」和图层属性可按名称、风格搜索。选择字体后，预览与导出的文字图片由浏览器用同一字体绘制。下表的授权核对范围是**用字体制作并商业发布视频、图片等成品**；字体文件的再分发或随产品内置不在本次核对范围内。实际使用时仍应保留官方来源与适用声明。

| 批次 | 字体 | 风格 | 获取与使用方式 | 官方来源 |
| --- | --- | --- | --- | --- |
| 基础 | Noto Sans SC | 黑体 | 已有网页字体 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/notosanssc) |
| 基础 | 方正黑体 | 黑体 | 从方正获取文件后上传 | [方正免费字体公告](https://www.foundertype.com/index.php/About/powerbus) |
| 基础 | 方正书宋 | 宋体 | 从方正获取文件后上传 | [方正免费字体公告](https://www.foundertype.com/index.php/About/powerbus) |
| 基础 | 方正楷体 | 楷体 | 从方正获取文件后上传 | [方正免费字体公告](https://www.foundertype.com/index.php/About/powerbus) |
| 基础 | 方正仿宋 | 仿宋 | 从方正获取文件后上传 | [方正免费字体公告](https://www.foundertype.com/index.php/About/powerbus) |
| 第一批 | 抖音美好体 | 标题黑体 | 官方 GitHub 字体，网页按需加载 | [ByteDance Fonts](https://github.com/bytedance/fonts) |
| 第一批 | 站酷高端黑 | 标题黑体 | 从站酷获取文件后上传 | [站酷字体页](https://www.zcool.com.cn/assets/ZNTY0OA%3D%3D.html) |
| 第一批 | 霞鹜文楷 | 手写楷体 | 官方 Lite 字体，网页按需加载 | [霞鹜文楷 Lite](https://github.com/lxgw/LxgwWenKai-Lite) |
| 第一批 | Poppins | 英文无衬线 | Google Fonts 网页字体 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/poppins) |
| 第一批 | Montserrat | 英文无衬线 | Google Fonts 网页字体 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/montserrat) |
| 第一批 | Caveat | 英文手写 | Google Fonts 网页字体 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/caveat) |
| 第二批 | 站酷庆科黄油体 | 圆角标题 | Google Fonts 网页字体 | [站酷字体页](https://www.zcool.com.cn/assets/ZNTcwNA%3D%3D.html) |
| 第二批 | 马善政 | 中文书法 | Google Fonts 网页字体 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/mashanzheng) |
| 第二批 | League Spartan | 英文粗标题 | Google Fonts 网页字体 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/leaguespartan) |
| 第二批 | Playfair Display | 英文衬线 | Google Fonts 网页字体 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/playfairdisplay) |
| 第二批 | Inter | 英文正文 | Google Fonts 网页字体 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/inter) |

网页字体依赖浏览器可访问 Google Fonts 或对应官方 GitHub 原始文件。若网络不可达，浏览器会回退到系统字体，导出成品也会随之改变。霞鹜文楷使用官方 Lite 版，包含常用汉字；需要生僻字时，可从[完整版项目](https://github.com/lxgw/LxgwWenKai)取得文件，并按下述方式上传。

方正四款和站酷高端黑需要字体文件。方正的官方下载目前要求登录；取得 `.ttf`、`.otf` 或 `.woff2` 后，在「素材库 → 字体」上传，单个文件不超过 20 MiB。系统以**文件名（不含扩展名）**作为字体族名称。为使已选字体归入清单，请把文件命名为表中的中文名称，或使用 `fontCatalog.ts` 中列出的别名。上传成功后，它会出现在字体搜索和选择器中；未上传时，编辑器仅列出来源，不提供会回退的假选项。

字体的网页加载与字体文件上传只负责编辑器预览和文字图片烘焙。不要直接将第三方字体文件加入 Git 仓库的 `samples/fonts/`；大文件会增大仓库和镜像。
