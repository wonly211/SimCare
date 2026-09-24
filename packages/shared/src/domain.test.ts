import { describe, expect, it } from 'vitest';
import {
  beijingDate,
  beijingNow,
  canCreateHealth,
  canEditOwned,
  canViewHealth,
  csvCell,
  dateSchema,
  healthInputSchema,
  todayMedication,
  type Grant,
  type HealthInput,
  type Medication,
  type Member,
} from './index';

const owner = '22222222-2222-4222-8222-222222222222';
const actor: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  nickname: '测试成员',
  systemRole: null,
  householdRole: 'member',
  active: true,
  createdAt: beijingNow(),
};
const input: HealthInput = {
  ownerId: owner,
  measuredAt: '2026-09-22T08:00:00+08:00',
  systolic: 120,
  diastolic: 80,
  pulse: null,
  oxygen: null,
  temperature: null,
  posture: 'sitting',
  arm: 'left',
  note: '',
};

describe('时间和输入契约', () => {
  it('不依赖设备时区，午夜换日为北京时间', () => {
    expect(beijingNow(new Date('2026-09-21T16:00:00Z'))).toBe('2026-09-22T00:00:00+08:00');
    expect(beijingDate(new Date('2026-09-21T15:59:59Z'))).toBe('2026-09-21');
  });
  it('只录血压允许，空记录和半组血压拒绝', () => {
    expect(healthInputSchema.safeParse(input).success).toBe(true);
    expect(healthInputSchema.safeParse({ ...input, diastolic: null }).success).toBe(false);
    expect(healthInputSchema.safeParse({ ...input, systolic: null, diastolic: null }).success).toBe(
      false,
    );
    expect(
      healthInputSchema.safeParse({ ...input, systolic: null, diastolic: null, temperature: 36.5 })
        .success,
    ).toBe(true);
  });
  it('拒绝非法日期和额外身份字段', () => {
    expect(dateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(
      healthInputSchema.safeParse({ ...input, measuredAt: '2026-02-30T08:00:00+08:00' }).success,
    ).toBe(false);
    expect(healthInputSchema.safeParse({ ...input, recordedBy: actor.id }).success).toBe(false);
  });
});
describe('权限', () => {
  it('默认无权，查看不代表照护，照护不代表编辑他人记录', () => {
    expect(canViewHealth(actor, owner, [])).toBe(false);
    const grants: Grant[] = [{ ownerId: owner, granteeId: actor.id, grant: 'view' }];
    expect(canViewHealth(actor, owner, grants)).toBe(true);
    expect(canCreateHealth(actor, owner, grants)).toBe(false);
    grants[0].grant = 'care';
    expect(canCreateHealth(actor, owner, grants)).toBe(true);
    expect(canEditOwned(actor, owner)).toBe(false);
  });
  it('管理员拥有照护权限，停用后无权', () => {
    const admin: Member = { ...actor, householdRole: 'admin' };
    expect(canCreateHealth(admin, owner, [])).toBe(true);
    expect(canViewHealth({ ...admin, active: false }, owner, [])).toBe(false);
    expect(canEditOwned({ ...admin, active: false }, owner)).toBe(false);
  });
});
describe('今日用药', () => {
  const medicine: Medication = {
    id: crypto.randomUUID(),
    ownerId: owner,
    name: '测试药品',
    specification: '',
    form: '',
    route: '',
    reason: '',
    note: '',
    startDate: '2026-09-21',
    endDate: '2026-09-23',
    status: 'active',
    version: 1,
    recordedBy: actor.id,
    updatedBy: actor.id,
    createdAt: beijingNow(),
    updatedAt: beijingNow(),
    deletedAt: null,
    schedules: [
      {
        id: crypto.randomUUID(),
        period: 'evening',
        time: null,
        dose: '2',
        unit: '片',
        meal: 'after',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
      {
        id: crypto.randomUUID(),
        period: 'morning',
        time: null,
        dose: '0.5',
        unit: '片',
        meal: 'before',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
      {
        id: crypto.randomUUID(),
        period: 'as_needed',
        time: null,
        dose: '1',
        unit: '片',
        meal: 'any',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
    ],
  };
  it('从早到晚并保持分时段用量，按需最后独立列出', () => {
    expect(todayMedication([medicine], '2026-09-22').map((item) => item.schedule.dose)).toEqual([
      '0.5',
      '2',
      '1',
    ]);
  });
  it('过滤日期、星期、暂停和删除', () => {
    expect(todayMedication([medicine], '2026-09-24')).toHaveLength(0);
    expect(todayMedication([{ ...medicine, status: 'paused' }], '2026-09-22')).toHaveLength(0);
    expect(todayMedication([{ ...medicine, deletedAt: beijingNow() }], '2026-09-22')).toHaveLength(
      0,
    );
    expect(
      todayMedication(
        [{ ...medicine, schedules: [{ ...medicine.schedules[0], weekdays: [1] }] }],
        '2026-09-22',
      ),
    ).toHaveLength(0);
  });
  it('CSV 防止公式执行并转义引号', () => {
    expect(csvCell('=1+1')).toBe('"\'=1+1"');
    expect(csvCell('a"b')).toBe('"a""b"');
  });
});
