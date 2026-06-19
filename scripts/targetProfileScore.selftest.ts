// 目标公司画像匹配度自测。Node + tsx 运行，无测试框架。
// 验证：分数 0-100、等级文案、空白返回 null、城市/规模/行业/岗位/薪资/风险各维度方向正确、永不抛异常。

import {
  calculateTargetProfileScore,
  getTargetProfileLevel,
  type TargetProfileInput,
} from '../src/app/targetProfileScore';
import { emptyCompanyInput } from '../src/storage';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function makeInput(over: Partial<TargetProfileInput> = {}): TargetProfileInput {
  return {
    city: '',
    role: '',
    salaryRange: '',
    jdText: '',
    companyInput: emptyCompanyInput(),
    companyAssessment: null,
    ...over,
  };
}

// --------------------------------------------------------------------------
section('getTargetProfileLevel 阈值');
check('85 -> 命中靶心', getTargetProfileLevel(85) === '命中靶心');
check('100 -> 命中靶心', getTargetProfileLevel(100) === '命中靶心');
check('70 -> 高度匹配', getTargetProfileLevel(70) === '高度匹配');
check('55 -> 可以重点聊', getTargetProfileLevel(55) === '可以重点聊');
check('40 -> 谨慎观察', getTargetProfileLevel(40) === '谨慎观察');
check('39 -> 偏离画像', getTargetProfileLevel(39) === '偏离画像');
check('0 -> 偏离画像', getTargetProfileLevel(0) === '偏离画像');

// --------------------------------------------------------------------------
section('空白与兼容');
check('全空白 -> null（待评估）', calculateTargetProfileScore(makeInput()) === null);
check(
  '仅城市非空 -> 非 null',
  calculateTargetProfileScore(makeInput({ city: '苏州' })) !== null,
);
check(
  '旧数据仅 sizeTier 也能算（兼容）',
  calculateTargetProfileScore(
    makeInput({ companyInput: { ...emptyCompanyInput(), sizeTier: 'medium' } }),
  ) !== null,
);

// --------------------------------------------------------------------------
section('靶心画像：苏州独墅湖 + 数据平台 + 800-1500人 + 17k');
const bullseye = calculateTargetProfileScore(
  makeInput({
    city: '苏州',
    role: '高级前端工程师',
    salaryRange: '16-18K',
    jdText:
      '独墅湖，负责数据平台与中后台配置化系统，要求 Vue3 + TypeScript，前端工程化与数据可视化。',
    companyInput: { ...emptyCompanyInput(), staffRange: '800-1500人', companyType: '自研业务' },
  }),
);
check('靶心 -> 非 null', bullseye !== null);
check('靶心分数 >= 85（命中靶心）', (bullseye?.score ?? 0) >= 85);
check('靶心等级为命中靶心', bullseye?.level === '命中靶心');
check('靶心 reason 含说明', (bullseye?.reason ?? '').length > 0);

// --------------------------------------------------------------------------
section('偏离画像：外包/驻场 + 纯切页面 + 小作坊 + 低薪');
const offTarget = calculateTargetProfileScore(
  makeInput({
    city: '某市',
    role: '前端（切页面）',
    salaryRange: '8-10K',
    jdText: '外包驻场项目，主要做营销活动页与官网切图，团队 20-30 人。',
    companyInput: { ...emptyCompanyInput(), companyType: '外包', staffRange: '20-30人' },
  }),
);
check('偏离 -> 非 null', offTarget !== null);
check('偏离分数明显低于靶心', (offTarget?.score ?? 100) < (bullseye?.score ?? 0));
check('偏离 reason 含风险项', (offTarget?.reason ?? '').includes('风险项'));

// --------------------------------------------------------------------------
section('杭州弱备选：滨江 + 平台前端，薪资分档');
const hzLow = calculateTargetProfileScore(
  makeInput({ city: '杭州', role: '平台前端', salaryRange: '16-18K', jdText: '滨江，中后台平台前端。' }),
);
const hzHigh = calculateTargetProfileScore(
  makeInput({ city: '杭州', role: '平台前端', salaryRange: '22-26K', jdText: '滨江，中后台平台前端。' }),
);
check('杭州低薪/高薪均非 null', hzLow !== null && hzHigh !== null);
check('杭州 20k+ 比低于 20k 分高', (hzHigh?.score ?? 0) > (hzLow?.score ?? 0));

// --------------------------------------------------------------------------
section('薪资缺失中性 + 城市分档方向');
const noSalary = calculateTargetProfileScore(
  makeInput({ city: '苏州', role: '中后台前端', jdText: '数据中台，Vue3。' }),
);
check('薪资缺失不判 0', (noSalary?.score ?? 0) > 0);
check('薪资缺失 reason 注明不足', (noSalary?.reason ?? '').includes('薪资信息不足'));

const suzhou = calculateTargetProfileScore(makeInput({ city: '苏州' }));
const otherCity = calculateTargetProfileScore(makeInput({ city: '北京' }));
check('苏州地理分高于非目标城市', (suzhou?.score ?? 0) > (otherCity?.score ?? 0));

// --------------------------------------------------------------------------
section('分数边界与健壮性（永不抛异常 / 0-100 整数）');
let robust = true;
const samples: TargetProfileInput[] = [
  makeInput({ jdText: '只有一句话' }),
  makeInput({ city: '苏州独墅湖', salaryRange: '乱七八糟非数字' }),
  makeInput({ jdText: '外包外包外包驻场切页面切图营销页活动页画饼', salaryRange: '1k' }),
];
for (const s of samples) {
  try {
    const r = calculateTargetProfileScore(s);
    if (r !== null) {
      if (!Number.isInteger(r.score) || r.score < 0 || r.score > 100) robust = false;
    }
  } catch {
    robust = false;
  }
}
check('多样输入均 0-100 整数且不抛异常', robust);

// --------------------------------------------------------------------------
section('Summary');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
