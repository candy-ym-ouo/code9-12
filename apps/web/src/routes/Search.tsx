import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useMeta, useSearch, useTags } from '../api/hooks.js';
import { STATUS_META, fmtDateTime, hitRateText } from '../lib/format.js';
import { authedImageUrl } from '../api/client.js';
import { useSession } from '../stores/session.js';

export default function Search() {
  const tz = useSession((s) => s.libraryTz);
  const { data: tags } = useTags();
  const { data: meta } = useMeta();
  const [q, setQ] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<'any' | 'all'>('any');
  const [anchors, setAnchors] = useState<string[]>([]);
  const [phenomena, setPhenomena] = useState<string[]>([]);
  const [season, setSeason] = useState<string[]>([]);
  const [hitRateMin, setHitRateMin] = useState<number | undefined>();
  const [sort, setSort] = useState('recent');
  const [paletteHex, setPaletteHex] = useState('');

  const search = useSearch({
    q,
    tagIds: tagIds.join(','),
    tagMode,
    anchors: anchors.join(','),
    phenomena: phenomena.join(','),
    season: season.join(','),
    hitRateMin,
    sort,
    paletteHex: paletteHex || undefined,
    size: 48,
  });

  const flat = (tags?.items ?? []).flatMap((g) => (g.children ?? []).map((c) => ({ id: c.id, name: c.name, domain: g.domain })));
  const result = search.data;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="组合检索">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Input.Search
              placeholder="关键词：标题 / 备注 / 地点 / 机位描述"
              style={{ width: 340 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Segmented
              value={tagMode}
              onChange={(v) => setTagMode(v as 'any' | 'all')}
              options={[
                { value: 'any', label: '任一标签' },
                { value: 'all', label: '全部标签' },
              ]}
            />
            <Select
              mode="multiple"
              allowClear
              placeholder="标签"
              style={{ minWidth: 260 }}
              value={tagIds}
              onChange={setTagIds}
              options={flat.map((t) => ({ value: t.id, label: t.name }))}
              maxTagCount={3}
            />
            <Select
              mode="multiple"
              allowClear
              placeholder="时段"
              style={{ minWidth: 200 }}
              value={anchors}
              onChange={setAnchors}
              options={(meta?.timeAnchors ?? []).map((a) => ({ value: a.key, label: a.label }))}
              maxTagCount={2}
            />
            <Select
              mode="multiple"
              allowClear
              placeholder="天气现象"
              style={{ minWidth: 180 }}
              value={phenomena}
              onChange={setPhenomena}
              options={[
                { value: 'wet_ground', label: '湿地面反射' },
                { value: 'after_rain', label: '雨后' },
                { value: 'fog', label: '雾' },
                { value: 'snow', label: '雪' },
                { value: 'neon_reflection', label: '霓虹反光' },
              ]}
              maxTagCount={2}
            />
            <Select
              mode="multiple"
              allowClear
              placeholder="季节（月）"
              style={{ minWidth: 160 }}
              value={season}
              onChange={setSeason}
              options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 月` }))}
              maxTagCount={3}
            />
            <Select
              allowClear
              placeholder="命中率下限"
              style={{ width: 150 }}
              value={hitRateMin}
              onChange={setHitRateMin}
              options={[
                { value: 0.5, label: '≥ 50%' },
                { value: 0.75, label: '≥ 75%' },
              ]}
            />
            <Select
              value={sort}
              onChange={setSort}
              style={{ width: 150 }}
              options={[
                { value: 'recent', label: '最近整理' },
                { value: 'hit_rate', label: '命中率' },
                { value: 'window_heat', label: '时机热度' },
                { value: 'rarity', label: '可复现难度' },
              ]}
            />
            <Input
              placeholder="按主色找（如 #2b4a6f）"
              style={{ width: 180 }}
              value={paletteHex}
              onChange={(e) => setPaletteHex(e.target.value)}
            />
          </Space>
        </Space>
      </Card>

      {result?.relaxed?.length ? (
        <Alert
          type="warning"
          showIcon
          message={
            result.minHits
              ? `为了凑够 ${result.minHits} 张候选，系统按「标签 → 气象 → 距离」逐级放宽（逐条列出，不做静默放宽）`
              : '为了让结果不为空，系统逐级放宽了条件（逐条列出，不做静默放宽）'
          }
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {result.relaxed.map((r, idx) => (
                <li key={`${r.field}-${idx}`}>{r.note}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      {result && result.total === 0 ? (
        <Alert
          type="info"
          showIcon
          message="没有结果"
          description={
            <Typography.Text>
              {result.suggestions?.message ??
                '继续放宽标签、时段或季节；也可以先去收件箱把未整理的卡补上标签。'}
            </Typography.Text>
          }
        />
      ) : null}

      <Typography.Text type="secondary">命中 {result?.total ?? 0} 张</Typography.Text>

      {(result?.items ?? []).length === 0 ? (
        <Empty description="还没有结果" />
      ) : (
        <Row gutter={[12, 12]}>
          {result!.items.map((i) => (
            <Col xs={24} md={12} xl={6} key={i.id}>
              <Card
                size="small"
                hoverable
                title={<Link to={`/inspirations/${i.id}`}>{i.title}</Link>}
                extra={<Tag color={STATUS_META[i.status].color}>{STATUS_META[i.status].label}</Tag>}
              >
                {i.assets[0] ? (
                  <img
                    src={authedImageUrl(i.assets[0].thumbUrl)}
                    alt={i.title}
                    style={{ width: '100%', height: 130, objectFit: 'cover', borderRadius: 6, marginBottom: 8 }}
                  />
                ) : null}
                <Space wrap size={[4, 4]}>
                  {i.tags.slice(0, 4).map((t) => (
                    <Tag key={t.id}>{t.name}</Tag>
                  ))}
                </Space>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {i.spot?.fuzz.label ?? '机位未定'} · 命中率{' '}
                    {hitRateText(i.hitRate, i.hitCount + i.partialCount + i.missCount)}
                    {i.windowSummary?.nextGoodAt ? ` · 下次可拍 ${fmtDateTime(i.windowSummary.nextGoodAt, tz)}` : ''}
                  </Typography.Text>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </Space>
  );
}
