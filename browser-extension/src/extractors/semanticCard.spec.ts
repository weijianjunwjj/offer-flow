import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import {
  addToSelection, dedupeSelectedCards, MAX_BATCH, readSelectedCard,
  removeFromSelection, resolveSemanticCardRoot, resolveSemanticCardRootFromPath,
  toQueueExpected, type SelectedCard,
} from './semanticCard';

function parse(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

/** 模拟 event.composedPath()：从节点向上到 document 的元素链。 */
function pathOf(el: Element): Element[] {
  const path: Element[] = [];
  let node: Element | null = el;
  while (node !== null) {
    path.push(node);
    node = node.parentElement;
  }
  return path;
}

const CARD = (id: string, role: string, salary: string, company: string): string => (
  `<li class="job-card-wrapper"><div class="job-card-box">`
  + `<a href="/job_detail/${id}.html?securityId=zz&ka=list"><span class="job-name">${role}</span>`
  + `<span class="salary">${salary}</span><span class="company-name">${company}</span>`
  + `<ul class="tag-list"><li>3-5年</li><li>本科</li></ul></a></div></li>`
);

function listDoc(cards: string): Document {
  return parse(
    `<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body>`
    + `<div class="job-list-container"><ul>${cards}</ul></div></body></html>`,
  );
}

describe('semanticCard — 语义根定位 (§八.1)', () => {
  it('从 composedPath 命中的内层节点向上定位最小语义卡片根（含标题+job_detail+薪资）', () => {
    const doc = listDoc(CARD('AAAA1111', '中级前端开发工程师', '11-13K', '易诚互动'));
    const titleSpan = doc.querySelector('.job-name')!;
    const root = resolveSemanticCardRootFromPath(pathOf(titleSpan));
    expect(root).not.toBeNull();
    expect(root!.querySelector('a[href*="/job_detail/"]')).not.toBeNull();
    // 根内可读到唯一 job_detail id 与标题。
    const card = readSelectedCard(root!);
    expect(card!.externalRecordId).toBe('AAAA1111');
    expect(card!.roleFromCard).toBe('中级前端开发工程师');
  });

  it('resolveSemanticCardRoot 向上climb到含 job_detail 的最小祖先', () => {
    const doc = listDoc(CARD('BBBB2222', 'Java开发工程师', '10-20K', '甲公司'));
    const salary = doc.querySelector('.salary')!;
    const root = resolveSemanticCardRoot(salary);
    expect(root).not.toBeNull();
    expect(readSelectedCard(root!)!.externalRecordId).toBe('BBBB2222');
  });
});

describe('semanticCard — 字段读取 (§八.16)', () => {
  it('companyDisplayName / role / salary / 经验 / 学历 来自用户所选卡片', () => {
    const doc = listDoc(CARD('CCCC3333', '中级前端开发工程师', '11-13K', '易诚互动'));
    const root = doc.querySelector('.job-card-box')!;
    const card = readSelectedCard(root)!;
    expect(card.companyDisplayName).toBe('易诚互动');
    expect(card.roleFromCard).toBe('中级前端开发工程师');
    expect(card.salaryFromCardNorm).toBe('11-13K');
    expect(card.salaryFromCard).toEqual({ minK: 11, maxK: 13, period: 'month' });
    expect(card.salaryDecodedFromPua).toBe(false);
    expect(card.experienceFromCard).toBe('3-5年');
    expect(card.educationFromCard).toBe('本科');
    expect(card.providerKey).toBe('boss_zhipin');
    expect(card.canonicalSourceUrl).toBe('https://www.zhipin.com/job_detail/CCCC3333.html');
  });

  it('无 job_detail 稳定 id 的节点不可入选（readSelectedCard=null）', () => {
    const doc = parse('<html><body><div class="job-card-box"><span class="job-name">前端工程师</span><span class="salary">10-20K</span></div></body></html>');
    expect(readSelectedCard(doc.querySelector('.job-card-box')!)).toBeNull();
  });

  it('接受真实 BOSS 含连字符/下划线的 externalRecordId，company 缺失不阻断选择身份', () => {
    const doc = parse('<html><body><li class="job-card-box"><div class="job-info">'
      + '<a class="job-name" href="/job_detail/fada7782fd39d2be0nB-2t_0F1NZ.html?securityId=redacted">硬件架构师</a>'
      + '<span>3-5年</span></div></li></body></html>');
    const card = readSelectedCard(doc.querySelector('.job-card-box')!);
    expect(card).not.toBeNull();
    expect(card!.externalRecordId).toBe('fada7782fd39d2be0nB-2t_0F1NZ');
    expect(card!.roleFromCard).toBe('硬件架构师');
    expect(card!.companyDisplayName).toBeNull();
    expect(card!.canonicalSourceUrl).toBe('https://www.zhipin.com/job_detail/fada7782fd39d2be0nB-2t_0F1NZ.html');
  });

  it('卡片 textContent 为 PUA 时只使用显式 data-salary 明文，不猜测薪资数字', () => {
    const doc = parse('<html><body><li class="job-card-box"><a href="/job_detail/PUA-1.html">'
      + '<span class="job-name">前端工程师</span><span class="salary" data-salary="18-25K">\uE001-\uE002K</span>'
      + '</a></li></body></html>');
    const card = readSelectedCard(doc.querySelector('.job-card-box')!);
    expect(card!.salaryFromCardNorm).toBe('18-25K');
    expect(card!.salaryFromCard).toEqual({ minK: 18, maxK: 25, period: 'month' });
    expect(card!.salaryDecodedFromPua).toBe(false);
  });

  it('只在 kanzhun 薪资字体和固定 PUA 数字段同时命中时解码 18-28K', () => {
    const doc = parse('<html><body><li class="job-card-box"><a href="/job_detail/PUA-2.html">'
      + '<span class="job-name">资深前端开发工程师</span>'
      + '<span class="job-salary" style="font-family: kanzhun-mix">\uE032\uE039-\uE033\uE039K</span>'
      + '</a></li></body></html>');
    const card = readSelectedCard(doc.querySelector('.job-card-box')!);
    expect(card!.salaryFromCardNorm).toBe('18-28K');
    expect(card!.salaryFromCard).toEqual({ minK: 18, maxK: 28, period: 'month' });
    expect(card!.salaryDecodedFromPua).toBe(true);
  });

  it('非 kanzhun 字体或范围外 PUA 均不解码', () => {
    const doc = parse('<html><body>'
      + '<li class="job-card-box no-font"><a href="/job_detail/PUA-3.html"><span class="job-name">前端工程师</span><span class="job-salary">\uE032\uE039-\uE033\uE039K</span></a></li>'
      + '<li class="job-card-box bad-code"><a href="/job_detail/PUA-4.html"><span class="job-name">后端工程师</span><span class="job-salary" style="font-family: kanzhun-Regular">\uE032\uE039-\uE041\uE039K</span></a></li>'
      + '</body></html>');
    expect(readSelectedCard(doc.querySelector('.no-font')!)!.salaryFromCard).toBeNull();
    expect(readSelectedCard(doc.querySelector('.bad-code')!)!.salaryFromCard).toBeNull();
  });

  it('从真实 footer 形状的 boss-info 公司链接读取公司，且不读取 boss-name 招聘者', () => {
    const doc = parse('<html><body><li class="job-card-box"><div class="job-info">'
      + '<a class="job-name" href="/job_detail/COMPANY-1.html">前端开发工程师</a>'
      + '<span class="job-salary">\uE033\uE031-\uE035\uE031K</span></div>'
      + '<div class="job-card-footer"><a class="boss-info" href="/gongsi/example.html" ka="company_logo_click_example">智身科技</a>'
      + '<span class="boss-name">某招聘者</span><span class="company-location">苏州·长桥</span></div></li></body></html>');
    const card = readSelectedCard(doc.querySelector('.job-card-box')!);
    expect(card!.companyDisplayName).toBe('智身科技');
    expect(card!.salaryFromCard).toBeNull();
  });
});

describe('semanticCard — 逻辑去重 (§八.2/§八.3)', () => {
  it('同一 externalRecordId 的外层 li 与内层 box 归并为一张逻辑卡', () => {
    const doc = listDoc(CARD('DDDD4444', '前端开发工程师', '12-18K', '乙公司'));
    const li = doc.querySelector('.job-card-wrapper')!;
    const box = doc.querySelector('.job-card-box')!;
    const cards = [readSelectedCard(li)!, readSelectedCard(box)!];
    expect(cards[0]!.externalRecordId).toBe('DDDD4444');
    const deduped = dedupeSelectedCards(cards);
    expect(deduped).toHaveLength(1);
  });

  it('hidden clone（同 id 的重复副本）不重复计数', () => {
    const doc = listDoc(
      CARD('EEEE5555', '前端工程师', '9-15K', '丙公司')
      + `<li class="job-card-wrapper" style="display:none"><div class="job-card-box"><a href="/job_detail/EEEE5555.html"><span class="job-name">前端工程师</span><span class="salary">9-15K</span></a></div></li>`,
    );
    const boxes = Array.from(doc.querySelectorAll('.job-card-box')).map((el) => readSelectedCard(el)!);
    expect(boxes).toHaveLength(2);
    expect(dedupeSelectedCards(boxes)).toHaveLength(1);
  });
});

describe('semanticCard — 选择集合 (§八.4/§八.19)', () => {
  function card(id: string): SelectedCard {
    return {
      root: listDoc(CARD(id, '前端', '10-20K', '公司X')).querySelector('.job-card-box')!,
      providerKey: 'boss_zhipin', externalRecordId: id, canonicalSourceUrl: `https://www.zhipin.com/job_detail/${id}.html`,
      roleFromCard: '前端', companyDisplayName: '公司X', salaryFromCardNorm: '10-20K',
      salaryFromCard: { minK: 10, maxK: 20, period: 'month' }, salaryDecodedFromPua: false,
      experienceFromCard: '3-5年', educationFromCard: '本科',
    };
  }

  it('重复勾选被拒绝，取消勾选生效', () => {
    let sel: SelectedCard[] = [];
    sel = addToSelection(sel, card('A')).next;
    const dup = addToSelection(sel, card('A'));
    expect(dup.added).toBe(false);
    expect(dup.reason).toBe('duplicate');
    sel = addToSelection(sel, card('B')).next;
    expect(sel).toHaveLength(2);
    sel = removeFromSelection(sel, 'A');
    expect(sel.map((c) => c.externalRecordId)).toEqual(['B']);
  });

  it('单批最多 8 条，超出被拒绝', () => {
    let sel: SelectedCard[] = [];
    for (let i = 0; i < MAX_BATCH; i += 1) sel = addToSelection(sel, card(`ID${i}`)).next;
    expect(sel).toHaveLength(8);
    const overflow = addToSelection(sel, card('ID_OVER'));
    expect(overflow.added).toBe(false);
    expect(overflow.reason).toBe('max_reached');
  });

  it('toQueueExpected 剥离活 DOM 引用，只留稳定数据', () => {
    const expected = toQueueExpected(card('Z'));
    expect(expected).not.toHaveProperty('root');
    expect(expected.externalRecordId).toBe('Z');
    expect(expected.companyDisplayName).toBe('公司X');
    expect(expected.salaryDecodedFromPua).toBe(false);
  });
});
