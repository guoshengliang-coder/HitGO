# samples

演示素材目录。`stickers/`、`fonts/` 里的文件在 API 启动时作为内置素材导入（compose 以只读方式挂载）；`videos/` 由 `scripts/seed_demo.sh` 上传成演示批次。大文件不要提交进仓库。

`stickers/` 里的几张占位贴纸由 `scripts/gen_sample_stickers.py` 生成（纯色块，单个 < 2 KB），改了脚本重跑即可；它们的作用是让新环境的「原料库」不是空的。
