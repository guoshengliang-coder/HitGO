// HIG-66: names, styles and source links for the selected publishing fonts.
// User supplied font bytes stay in the asset library; open web faces load from index.html or styles.css.

export type FontGroup = 'basic' | 'popular' | 'more';
export type FontDelivery = 'web' | 'asset';

export interface CatalogFont {
  family: string;
  label: string;
  group: FontGroup;
  style: string;
  sample: string;
  delivery: FontDelivery;
  aliases?: string[];
  sourceUrl: string;
}

export const FONT_GROUP_LABEL: Record<FontGroup, string> = {
  basic: '基础字体',
  popular: '常用素材',
  more: '更多风格',
};

export const FONT_CATALOG: CatalogFont[] = [
  { family: 'Noto Sans SC', label: 'Noto Sans SC', group: 'basic', style: '黑体', sample: '字体', delivery: 'web', sourceUrl: 'https://github.com/google/fonts/tree/main/ofl/notosanssc' },
  { family: '方正黑体', label: '方正黑体', group: 'basic', style: '黑体', sample: '字体', delivery: 'asset', aliases: ['方正黑体简体', 'FZHei', 'FZHei-B01'], sourceUrl: 'https://www.foundertype.com/index.php/About/powerbus' },
  { family: '方正书宋', label: '方正书宋', group: 'basic', style: '宋体', sample: '字体', delivery: 'asset', aliases: ['方正书宋简体', 'FZShuSong', 'FZShuSong-Z01'], sourceUrl: 'https://www.foundertype.com/index.php/About/powerbus' },
  { family: '方正楷体', label: '方正楷体', group: 'basic', style: '楷体', sample: '字体', delivery: 'asset', aliases: ['方正楷体简体', 'FZKai', 'FZKai-Z03'], sourceUrl: 'https://www.foundertype.com/index.php/About/powerbus' },
  { family: '方正仿宋', label: '方正仿宋', group: 'basic', style: '仿宋', sample: '字体', delivery: 'asset', aliases: ['方正仿宋简体', 'FZFangSong', 'FZFangSong-Z02'], sourceUrl: 'https://www.foundertype.com/index.php/About/powerbus' },
  { family: '抖音美好体', label: '抖音美好体', group: 'popular', style: '标题黑体', sample: '字体', delivery: 'web', aliases: ['Douyin Sans', 'DouyinSans'], sourceUrl: 'https://github.com/bytedance/fonts' },
  { family: '站酷高端黑', label: '站酷高端黑', group: 'popular', style: '标题黑体', sample: '字体', delivery: 'asset', aliases: ['ZCOOL GaoDuanHei'], sourceUrl: 'https://www.zcool.com.cn/assets/ZNTY0OA%3D%3D.html' },
  { family: '霞鹜文楷', label: '霞鹜文楷', group: 'popular', style: '手写楷体', sample: '字体', delivery: 'web', aliases: ['LXGW WenKai', 'LXGWWenKai-Regular', 'LXGWWenKaiLite-Regular'], sourceUrl: 'https://github.com/lxgw/LxgwWenKai-Lite' },
  { family: 'Poppins', label: 'Poppins', group: 'popular', style: '英文无衬线', sample: 'Aa', delivery: 'web', sourceUrl: 'https://github.com/google/fonts/tree/main/ofl/poppins' },
  { family: 'Montserrat', label: 'Montserrat', group: 'popular', style: '英文无衬线', sample: 'Aa', delivery: 'web', sourceUrl: 'https://github.com/google/fonts/tree/main/ofl/montserrat' },
  { family: 'Caveat', label: 'Caveat', group: 'popular', style: '英文手写', sample: 'Aa', delivery: 'web', sourceUrl: 'https://github.com/google/fonts/tree/main/ofl/caveat' },
  { family: 'ZCOOL QingKe HuangYou', label: '站酷庆科黄油体', group: 'more', style: '圆角标题', sample: '字体', delivery: 'web', aliases: ['站酷庆科黄油体'], sourceUrl: 'https://www.zcool.com.cn/assets/ZNTcwNA%3D%3D.html' },
  { family: 'Ma Shan Zheng', label: '马善政', group: 'more', style: '中文书法', sample: '字体', delivery: 'web', aliases: ['马善政'], sourceUrl: 'https://github.com/google/fonts/tree/main/ofl/mashanzheng' },
  { family: 'League Spartan', label: 'League Spartan', group: 'more', style: '英文粗标题', sample: 'Aa', delivery: 'web', sourceUrl: 'https://github.com/google/fonts/tree/main/ofl/leaguespartan' },
  { family: 'Playfair Display', label: 'Playfair Display', group: 'more', style: '英文衬线', sample: 'Aa', delivery: 'web', sourceUrl: 'https://github.com/google/fonts/tree/main/ofl/playfairdisplay' },
  { family: 'Inter', label: 'Inter', group: 'more', style: '英文正文', sample: 'Aa', delivery: 'web', sourceUrl: 'https://github.com/google/fonts/tree/main/ofl/inter' },
];

const normalize = (s: string) => s.toLocaleLowerCase().replace(/[\s_\-]+/g, '');

export function catalogFontFor(name: string): CatalogFont | undefined {
  const key = normalize(name);
  return FONT_CATALOG.find((font) => [font.family, font.label, ...(font.aliases ?? [])].some((alias) => normalize(alias) === key));
}

export function fontMatchesQuery(font: Pick<CatalogFont, 'family' | 'label' | 'style' | 'aliases'>, query: string): boolean {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [font.family, font.label, font.style, ...(font.aliases ?? [])].join(' ').toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}
