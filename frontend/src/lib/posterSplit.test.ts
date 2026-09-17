import { describe, expect, it } from 'vitest';
import { splitByPunctuation, trimTailPunct } from './posterSplit';

describe('splitByPunctuation', () => {
  it('中文断句标点后换行，标点留在行尾', () => {
    expect(splitByPunctuation('北京时间今天凌晨，收到消息。即日起国内要解决以下七类问题！这七类人注意了')).toBe('北京时间今天凌晨，\n收到消息。\n即日起国内要解决以下七类问题！\n这七类人注意了');
    expect(splitByPunctuation('第一、第二；第三：结尾……')).toBe('第一、\n第二；\n第三：\n结尾……');
  });

  it('连续标点和收尾引号跟着上一行', () => {
    expect(splitByPunctuation('真的吗？！他说：“好。”然后走了')).toBe('真的吗？！\n他说：\n“好。”\n然后走了');
    expect(splitByPunctuation('（完）。下一句')).toBe('（完）。\n下一句');
  });

  it('半角标点：数字、网址、缩写中间不断', () => {
    expect(splitByPunctuation('价格 3.5 元, 共 1,000 件. 访问 hitgo.com 了解')).toBe('价格 3.5 元,\n共 1,000 件.\n访问 hitgo.com 了解');
    expect(splitByPunctuation('Hello, world! Bye.')).toBe('Hello,\nworld!\nBye.');
    expect(splitByPunctuation('时间10:30开始')).toBe('时间10:30开始');
  });

  it('原有换行保留，空行并成一个，首尾空白去掉', () => {
    expect(splitByPunctuation('第一段，接着\r\n\n\n  第二段。  \n')).toBe('第一段，\n接着\n\n第二段。');
    expect(splitByPunctuation('')).toBe('');
    expect(splitByPunctuation('没有标点')).toBe('没有标点');
  });

  it('去掉逗号类：只删行尾的，、；：', () => {
    expect(splitByPunctuation('凌晨，收到消息。真的吗？第一、第二', 'drop-pause')).toBe('凌晨\n收到消息。\n真的吗？\n第一\n第二');
  });

  it('全部去掉：行尾断句标点都删，收尾引号保留', () => {
    expect(splitByPunctuation('凌晨，收到消息。他说：“好。”结尾……', 'drop-all')).toBe('凌晨\n收到消息\n他说\n“好”\n结尾');
    // 只有标点的行去完就没了
    expect(splitByPunctuation('好\n。。。', 'drop-all')).toBe('好');
  });

  it('trimTailPunct 不动行中标点', () => {
    expect(trimTailPunct('a，b，', 'drop-pause')).toBe('a，b');
    expect(trimTailPunct('a，b，', 'keep')).toBe('a，b，');
  });
});
