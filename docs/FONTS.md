# 字体清单（HIG-66）

编辑器的「文字 → 字体」和图层属性可按名称、风格搜索。选择字体后，预览与导出的文字图片由浏览器用同一字体绘制。清单字体直接通过网页字体样式表加载，无需用户上传。自有授权的其他字体仍可在「素材库 → 字体」上传。

| 批次 | 字体 | 风格 | 网页加载来源 | 字体项目或授权来源 |
| --- | --- | --- | --- | --- |
| 基础 | Noto Sans SC | 黑体 | Google Fonts | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/notosanssc) |
| 基础 | IBM Plex Sans SC | 黑体 | [ZSFT](https://fonts.zeoseven.com/items/389/) | [IBM Plex，OFL 1.1](https://github.com/IBM/plex/tree/master/packages/plex-sans-sc) |
| 基础 | Noto Serif SC（思源宋体） | 宋体 | Google Fonts | [Google Fonts，OFL](https://github.com/google/fonts/tree/main/ofl/notoserifsc) |
| 基础 | 霞鹜臻楷 | 楷体 | [ZSFT](https://fonts.zeoseven.com/items/2/) | [作者项目，OFL 1.1](https://github.com/lxgw/LxgwZhenKai) |
| 基础 | 朱雀仿宋 | 仿宋 | [ZSFT](https://fonts.zeoseven.com/items/7/) | [作者项目，OFL 1.1](https://github.com/TrionesType/zhuque) |
| 第一批 | 抖音美好体 | 标题黑体 | 官方 GitHub 字体 | [ByteDance Fonts](https://github.com/bytedance/fonts) |
| 第一批 | 站酷高端黑 | 标题黑体 | [ZSFT](https://fonts.zeoseven.com/items/632/) | [站酷免费字体页](https://www.zcool.com.cn/assets/ZNTY0OA%3D%3D.html) |
| 第一批 | 霞鹜文楷 | 手写楷体 | 官方 Lite 字体 | [霞鹜文楷 Lite](https://github.com/lxgw/LxgwWenKai-Lite) |
| 第一批 | Poppins | 英文无衬线 | Google Fonts | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/poppins) |
| 第一批 | Montserrat | 英文无衬线 | Google Fonts | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/montserrat) |
| 第一批 | Caveat | 英文手写 | Google Fonts | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/caveat) |
| 第二批 | 站酷庆科黄油体 | 圆角标题 | Google Fonts | [站酷字体页](https://www.zcool.com.cn/assets/ZNTcwNA%3D%3D.html) |
| 第二批 | 马善政 | 中文书法 | Google Fonts | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/mashanzheng) |
| 第二批 | League Spartan | 英文粗标题 | Google Fonts | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/leaguespartan) |
| 第二批 | Playfair Display | 英文衬线 | Google Fonts | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/playfairdisplay) |
| 第二批 | Inter | 英文正文 | Google Fonts | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/inter) |

之前清单中的方正黑体、方正书宋、方正楷体、方正仿宋已分别换为 IBM Plex Sans SC、Noto Serif SC、霞鹜臻楷、朱雀仿宋。方正官方说明这四款针对商业发布可免费使用，但[免费授权明确排除 Web Font 在线网络字体](https://www.foundertype.com/index.php/Index/plusHelp.html)；浏览器编辑器需要加载字体文件，不能仅靠上传文件解决授权范围问题。

站酷官方页面标明站酷高端黑可免费商用。当前通过 ZSFT 提供的网页字体服务加载，用户无需获取或上传原字体文件。朱雀仿宋目前是 **technical preview**，字形和字符覆盖可能随正式版变化。上述网页字体依赖浏览器能访问 Google Fonts、GitHub 或 ZSFT；若网络不可达，浏览器会回退到系统字体，导出成品也会随之改变。霞鹜文楷使用官方 Lite 版，生僻字可从[完整版项目](https://github.com/lxgw/LxgwWenKai)取得。
