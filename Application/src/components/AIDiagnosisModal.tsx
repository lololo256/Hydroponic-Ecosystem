import { useState, useMemo, useEffect } from 'react';
import { useSmartFarm } from '../context/SmartFarmContext';
import { getEffectiveTargets } from '../services/telemetryContract';
import { analyzeSensorHealth, type Sample } from '../services/sensorHealth';
import { Browser } from '@capacitor/browser';
import {
  X,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Copy,
  Check,
  Droplets,
  Zap,
  Thermometer,
  WifiOff,
  Share2,
  Activity,
  CircleDashed,
} from 'lucide-react';
import { FEATURES } from '../config/features';

interface DiagnosticIssue {
  id: string;
  type: 'ph' | 'ec' | 'tds' | 'temp' | 'connection' | 'sensor';
  title: string;
  description: string;
  severity: 'danger' | 'warning';
  currentVal: string;
  targetVal: string;
}

interface AIDiagnosisModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SENSOR_LABELS: Array<{ key: 'pH' | 'ec' | 'tds' | 'tempC'; label: string }> = [
  { key: 'pH', label: 'pH' },
  { key: 'ec', label: 'EC' },
  { key: 'tds', label: 'TDS' },
  { key: 'tempC', label: 'อุณหภูมิน้ำ' },
];

/** Legacy fallback when the async Clipboard API is missing/blocked (some WebViews). */
const legacyCopy = (text: string): boolean => {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

export default function AIDiagnosisModal({ isOpen, onClose }: AIDiagnosisModalProps) {
  const { data, telemetryFreshness } = useSmartFarm();
  const [copiedToast, setCopiedToast] = useState<string | null>(null);
  // Clipboard failed -> show the prompt for manual copy; AI buttons then open the site directly
  const [manualCopy, setManualCopy] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setManualCopy(false);
      setCopiedToast(null);
    }
  }, [isOpen]);

  // ── 0. Which readings actually exist (never claim "normal" without data) ──
  const missingSensors = useMemo(
    () =>
      SENSOR_LABELS.filter(({ key }) => data.current[key] === null || data.current[key] === undefined).map(
        (s) => s.label
      ),
    [data.current]
  );
  const hasReadings = missingSensors.length < SENSOR_LABELS.length;

  // ── 0.1 Sensor-health findings from the last 3 h of real history (same engine as the alerts) ──
  const healthFindings = useMemo(() => {
    const now = Date.now();
    const points = Object.values(data.history || {}).filter((p) => p && p.timestamp >= now - 3 * 3600_000);
    const toSeries = (pick: (p: (typeof points)[number]) => number | null | undefined): Sample[] =>
      points
        .map((p) => ({ ts: p.timestamp, value: pick(p) }))
        .filter((x): x is Sample => typeof x.value === 'number' && Number.isFinite(x.value));
    try {
      const report = analyzeSensorHealth({
        now,
        freshness: telemetryFreshness,
        isSim: FEATURES.showDemoBoardLabels && Boolean(data.device.isSim),
        sensorOk: data.device.sensorOk ?? null,
        current: { pH: data.current.pH, ec: data.current.ec, tempC: data.current.tempC },
        series: { ph: toSeries((p) => p.pH), ec: toSeries((p) => p.ec), temp: toSeries((p) => p.tempC) },
      });
      return report.checks.filter((c) => c.level === 'warning' || c.level === 'critical');
    } catch {
      return [];
    }
  }, [data.history, data.current, data.device.isSim, data.device.sensorOk, telemetryFreshness]);

  // ── 1. Smart Problem Detection Logic (Zero Mock Data) ──
  const issues = useMemo<DiagnosticIssue[]>(() => {
    const list: DiagnosticIssue[] = [];
    const { current, device } = data;
    // Single source for target ranges (board-confirmed -> requested -> firmware defaults)
    const targets: any = { ...(data.targets || {}), ...getEffectiveTargets(data) };

    // Check ESP32 Connection
    if (!device.esp32Connected) {
      list.push({
        id: 'conn_offline',
        type: 'connection',
        title: 'อุปกรณ์ออฟไลน์ (ขาดการเชื่อมต่อ)',
        description: 'ไม่พบสัญญาณสดจากอุปกรณ์ แอปล็อกการสั่งงานปั๊มไว้จนกว่าอุปกรณ์จะกลับมาออนไลน์',
        severity: 'danger',
        currentVal: 'ออฟไลน์',
        targetVal: 'ออนไลน์',
      });
    }

    // Check pH
    if (current.pH !== null && current.pH !== undefined) {
      const minPh = targets?.phMin ?? 5.5;
      const maxPh = targets?.phMax ?? 6.5;
      if (current.pH < minPh) {
        list.push({
          id: 'ph_low',
          type: 'ph',
          title: 'ค่า pH ต่ำกว่าเกณฑ์ (น้ำเป็นกรด)',
          description: 'สภาพน้ำเป็นกรดขัดขวางการดูดซึมธาตุอาหารหลัก (N, P, K) ทำให้พืชเติบโตช้าหรือใบเหลือง',
          severity: 'danger',
          currentVal: current.pH.toFixed(2),
          targetVal: `${minPh.toFixed(1)} - ${maxPh.toFixed(1)}`,
        });
      } else if (current.pH > maxPh) {
        list.push({
          id: 'ph_high',
          type: 'ph',
          title: 'ค่า pH สูงกว่าเกณฑ์ (น้ำเป็นด่าง)',
          description: 'สภาพน้ำเป็นด่างทำให้ธาตุเหล็ก (Fe) และจุลธาตุตกตะกอน รากดูดซึมไม่ได้ เสี่ยงยอดหงิกงอ',
          severity: 'warning',
          currentVal: current.pH.toFixed(2),
          targetVal: `${minPh.toFixed(1)} - ${maxPh.toFixed(1)}`,
        });
      }
    }

    // Check EC / Nutrient
    if (current.ec !== null && current.ec !== undefined) {
      const minEc = targets?.ecMin ?? 1.2;
      const maxEc = targets?.ecMax ?? 1.8;
      if (current.ec < minEc) {
        list.push({
          id: 'ec_low',
          type: 'ec',
          title: 'ค่า EC ต่ำกว่าเกณฑ์ (ปุ๋ยเจือจาง)',
          description: 'สารละลายธาตุอาหารเจือจางเกินไป พืชได้รับสารอาหารไม่เพียงพอ ต้นจะแคระแกร็นและโตช้า',
          severity: 'warning',
          currentVal: `${current.ec.toFixed(2)} mS/cm`,
          targetVal: `${minEc.toFixed(1)} - ${maxEc.toFixed(1)} mS/cm`,
        });
      } else if (current.ec > maxEc) {
        list.push({
          id: 'ec_high',
          type: 'ec',
          title: 'ค่า EC สูงกว่าเกณฑ์ (ปุ๋ยเข้มข้นเกินไป)',
          description: 'สารละลายเข้มข้นจัดเกิดภาวะปุ๋ยเค็ม เสี่ยงปลายใบไหม้ (Tip Burn) และรากช็อกดูดน้ำไม่ได้',
          severity: 'danger',
          currentVal: `${current.ec.toFixed(2)} mS/cm`,
          targetVal: `${minEc.toFixed(1)} - ${maxEc.toFixed(1)} mS/cm`,
        });
      }
    }

    // Check TDS / Mineral Dissolution
    if (current.tds !== null && current.tds !== undefined) {
      const minEc = targets?.ecMin ?? 1.2;
      const maxEc = targets?.ecMax ?? 1.8;
      const minTds = targets?.tdsMin ?? Math.round(minEc * 500);
      const maxTds = targets?.tdsMax ?? Math.round(maxEc * 500);
      if (current.tds < minTds) {
        list.push({
          id: 'tds_low',
          type: 'tds',
          title: 'ค่า TDS แร่ธาตุต่ำกว่าเกณฑ์',
          description: 'ปริมาณของแข็งและแร่ธาตุที่ละลายในน้ำต่ำกว่าเกณฑ์ พืชอาจได้รับสารอาหารไม่เพียงพอต่อการเจริญเติบโต',
          severity: 'warning',
          currentVal: `${current.tds} ppm`,
          targetVal: `${minTds} - ${maxTds} ppm`,
        });
      } else if (current.tds > maxTds) {
        list.push({
          id: 'tds_high',
          type: 'tds',
          title: 'ค่า TDS แร่ธาตุสูงเกินเกณฑ์',
          description: 'ปริมาณเกลือแร่ละลายในน้ำสูงจัด อาจเกิดการสะสมของเกลือตกค้าง เสี่ยงรากพืชขาดน้ำจากภาวะปุ๋ยเค็ม',
          severity: 'danger',
          currentVal: `${current.tds} ppm`,
          targetVal: `${minTds} - ${maxTds} ppm`,
        });
      }
    }

    // Check Water Temperature
    if (current.tempC !== null && current.tempC !== undefined) {
      const minTemp = targets?.tempMin ?? 22.0;
      const maxTemp = targets?.tempMax ?? 28.0;
      if (current.tempC > maxTemp) {
        list.push({
          id: 'temp_high',
          type: 'temp',
          title: 'อุณหภูมิน้ำสูงเกินเกณฑ์ปลอดภัย',
          description: 'น้ำร้อนเกินไปทำให้ออกซิเจนละลายในน้ำ (DO) ลดลงอย่างมาก เสี่ยงเกิดโรครากเน่าและเชื้อรา',
          severity: 'danger',
          currentVal: `${current.tempC.toFixed(1)}°C`,
          targetVal: `${minTemp.toFixed(1)} - ${maxTemp.toFixed(1)}°C`,
        });
      } else if (current.tempC < minTemp) {
        list.push({
          id: 'temp_low',
          type: 'temp',
          title: 'อุณหภูมิน้ำต่ำกว่าเกณฑ์',
          description: 'น้ำเย็นเกินไปทำให้กระบวนการเมแทบอลิซึมและการดูดซึมปุ๋ยของรากช้าลง',
          severity: 'warning',
          currentVal: `${current.tempC.toFixed(1)}°C`,
          targetVal: `${minTemp.toFixed(1)} - ${maxTemp.toFixed(1)}°C`,
        });
      }
    }

    // Sensor-health findings (stuck value, spikes, out of physical range, ...)
    healthFindings.forEach((c) => {
      list.push({
        id: `health_${c.id}`,
        type: 'sensor',
        title: c.title,
        description: c.advice ? `${c.detail} แนะนำ: ${c.advice}` : c.detail,
        severity: c.level === 'critical' ? 'danger' : 'warning',
        currentVal: 'ตรวจเซนเซอร์',
        targetVal: '-',
      });
    });

    return list;
  }, [data, healthFindings]);

  // ── 2. Format Structured Prompt for External AI ──
  const generatedPrompt = useMemo(() => {
    const plant = data.plantType || 'พืชไฮโดรโปนิกส์';
    const { current, device } = data;
    // Single source for target ranges (board-confirmed -> requested -> firmware defaults)
    const targets: any = { ...(data.targets || {}), ...getEffectiveTargets(data) };
    const minEc = targets?.ecMin ?? 1.2;
    const maxEc = targets?.ecMax ?? 1.8;
    const minTds = targets?.tdsMin ?? Math.round(minEc * 500);
    const maxTds = targets?.tdsMax ?? Math.round(maxEc * 500);

    const statusHeader = `[วิเคราะห์ปัญหาฟาร์มไฮโดรโปนิกส์]
แปลงปลูก: ${plant}
สถานะอุปกรณ์: ${device.esp32Connected ? 'ออนไลน์' : 'ออฟไลน์ (ตัดการเชื่อมต่อ)'}

ค่าพารามิเตอร์ปัจจุบัน:
- ค่า pH: ${current.pH !== null ? current.pH.toFixed(2) : '--'} (เป้าหมาย: ${targets?.phMin ?? 5.5} - ${targets?.phMax ?? 6.5})
- ค่า EC: ${current.ec !== null ? current.ec.toFixed(2) : '--'} mS/cm (เป้าหมาย: ${minEc.toFixed(1)} - ${maxEc.toFixed(1)} mS/cm)
- ค่า TDS: ${current.tds !== null ? `${current.tds} ppm` : '--'} (เป้าหมาย: ${minTds} - ${maxTds} ppm)
- อุณหภูมิน้ำ: ${current.tempC !== null ? current.tempC.toFixed(1) : '--'}°C (เป้าหมาย: ${targets?.tempMin ?? 22.0} - ${targets?.tempMax ?? 28.0}°C)
`;

    let issuesText = '';
    if (issues.length > 0) {
      issuesText =
        `\nประเด็นที่แอปตรวจพบ (${issues.length} รายการ):\n` +
        issues
          .map(
            (iss, i) =>
              `${i + 1}. [${iss.severity === 'danger' ? 'วิกฤต' : 'เตือน'}] ${iss.title}\n   - ค่าที่วัดได้: ${iss.currentVal} (เกณฑ์: ${iss.targetVal})\n   - รายละเอียด: ${iss.description}`
          )
          .join('\n');
    } else if (hasReadings) {
      issuesText = `\nสถานะระบบ: ค่าที่วัดได้อยู่ในช่วงเป้าหมาย`;
    }
    if (!hasReadings) {
      issuesText += `\nหมายเหตุ: ยังไม่มีค่าตรวจวัดจากเซนเซอร์ จึงยังยืนยันไม่ได้ว่าค่าปกติหรือไม่`;
    } else if (missingSensors.length > 0) {
      issuesText += `\nหมายเหตุ: ไม่มีค่าตรวจวัดของ ${missingSensors.join(', ')}`;
    }

    const questionFooter =
      issues.length > 0
        ? `\n\nคำถาม:
1. วิเคราะห์สาเหตุที่เป็นไปได้ของประเด็นข้างต้นในระบบไฮโดรโปนิกส์
2. แนะนำขั้นตอนแก้ไขตามลำดับความสำคัญ เพื่อป้องกันต้นพืชเสียหาย
3. แนวทางป้องกันปัญหานี้ในระยะยาว`
        : !hasReadings
          ? `\n\nคำถาม:
1. ควรตรวจสอบอะไรบ้างเมื่ออุปกรณ์ไม่ส่งค่าเซนเซอร์ pH/EC/อุณหภูมิน้ำ
2. ระหว่างรอค่าตรวจวัด ควรดูแลแปลง ${plant} อย่างไร`
          : `\n\nคำถาม:
1. แนะนำการดูแลสารละลายธาตุอาหารของ ${plant} ในระยะนี้
2. ควรเฝ้าระวังค่าใดเป็นพิเศษ`;

    return `${statusHeader}${issuesText}${questionFooter}`;
  }, [data, issues, hasReadings, missingSensors]);

  if (!isOpen) return null;

  const bannerTone =
    issues.length > 0
      ? { bg: '#fff7ed', border: '#fed7aa', iconBg: '#ffedd5', icon: '#ea580c', title: '#9a3412', body: '#c2410c' }
      : !hasReadings
        ? { bg: '#f8fafc', border: '#e2e8f0', iconBg: '#f1f5f9', icon: '#64748b', title: '#334155', body: '#64748b' }
        : { bg: '#f0fdf4', border: '#bbf7d0', iconBg: '#dcfce7', icon: '#16a34a', title: '#166534', body: '#15803d' };

  // Copy to clipboard helper: the success toast appears only after the copy really succeeded
  const copyPromptToClipboard = async (appName?: string): Promise<boolean> => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(generatedPrompt);
        ok = true;
      }
    } catch (_) {
      ok = false;
    }
    if (!ok) ok = legacyCopy(generatedPrompt);

    if (!ok) {
      setManualCopy(true);
      setCopiedToast(null);
      return false;
    }

    const msg = appName
      ? `คัดลอกข้อมูลแล้ว กำลังเปิด ${appName} กด "วาง" เพื่อถามได้เลย`
      : 'คัดลอกข้อความเรียบร้อยแล้ว';

    setCopiedToast(msg);
    setTimeout(() => setCopiedToast(null), 3000);
    return true;
  };

  // Launch External AI App
  const handleLaunchAI = async (service: 'chatgpt' | 'gemini' | 'claude') => {
    let url = '';
    let name = '';

    switch (service) {
      case 'chatgpt':
        url = 'https://chatgpt.com/';
        name = 'ChatGPT';
        break;
      case 'gemini':
        url = 'https://gemini.google.com/';
        name = 'Google Gemini';
        break;
      case 'claude':
        url = 'https://claude.ai/';
        name = 'Claude AI';
        break;
    }

    // Manual-copy mode: the user copies the text shown below themselves, so just open the site
    if (!manualCopy) {
      const copied = await copyPromptToClipboard(name);
      if (!copied) return; // keep the modal open showing the text for manual copy
    }

    try {
      await Browser.open({ url });
    } catch (_) {
      window.open(url, '_blank');
    }

    if (!manualCopy) {
      setTimeout(() => {
        onClose();
      }, 1500);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(15, 23, 42, 0.65)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: '0 0 max(16px, env(safe-area-inset-bottom))',
        animation: 'fadeIn 0.2s ease-out',
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Toast Notification */}
      {copiedToast && (
        <div
          style={{
            position: 'fixed',
            top: 24,
            left: 20,
            right: 20,
            zIndex: 10001,
            background: '#0f172a',
            color: '#ffffff',
            padding: '12px 16px',
            borderRadius: 14,
            boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12.5,
            fontWeight: 500,
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          <Check size={18} className="text-emerald-400 flex-shrink-0" />
          <span>{copiedToast}</span>
        </div>
      )}

      {/* Modal Card / Bottom Sheet */}
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          background: '#ffffff',
          borderRadius: '24px 24px 20px 20px',
          boxShadow: '0 -10px 35px rgba(0, 0, 0, 0.2)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '18px 20px 14px',
            borderBottom: '1px solid #f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                background: '#ecfdf5',
                color: '#059669',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Sparkles size={20} />
            </div>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', margin: 0 }}>
                ส่งข้อมูลให้ AI ภายนอกช่วยวิเคราะห์
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: 11.5, color: '#64748b' }}>
                แปลง: {data.plantType || 'พืชไฮโดรโปนิกส์'} • สรุปจากค่าจริงของอุปกรณ์
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: '#f1f5f9',
              border: 'none',
              width: 44,
              height: 44,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: '#64748b',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div style={{ padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Status Alert Banner: issues / no readings / measured values in range */}
          <div
            style={{
              background: bannerTone.bg,
              borderRadius: 14,
              border: `1px solid ${bannerTone.border}`,
              padding: '12px 14px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: bannerTone.iconBg,
                color: bannerTone.icon,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {issues.length > 0 ? (
                <AlertTriangle size={18} />
              ) : !hasReadings ? (
                <CircleDashed size={18} />
              ) : (
                <CheckCircle2 size={18} />
              )}
            </div>
            <div>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: bannerTone.title,
                  display: 'block',
                }}
              >
                {issues.length > 0
                  ? `ตรวจพบประเด็นที่ควรดูแล ${issues.length} รายการ`
                  : !hasReadings
                    ? 'ยังไม่มีค่าตรวจวัด'
                    : 'ค่าที่วัดได้อยู่ในช่วงเป้าหมาย'}
              </span>
              <p
                style={{
                  margin: '2px 0 0',
                  fontSize: 11,
                  color: bannerTone.body,
                  lineHeight: 1.4,
                }}
              >
                {issues.length > 0
                  ? 'แอปสรุปประเด็นจากค่าจริงให้แล้ว เลือกแอป AI ด้านล่างเพื่อขอแนวทางแก้ไข (คำตอบมาจาก AI ภายนอก)'
                  : !hasReadings
                    ? 'อุปกรณ์ยังไม่ส่งค่า pH, EC หรืออุณหภูมิน้ำ จึงยังสรุปไม่ได้ว่าปกติหรือไม่'
                    : missingSensors.length > 0
                      ? `ไม่มีค่าตรวจวัดของ ${missingSensors.join(', ')} • เลือกแอป AI เพื่อขอคำแนะนำการดูแลทั่วไปได้`
                      : 'ไม่พบค่านอกเกณฑ์ เลือกแอป AI เพื่อขอคำแนะนำการดูแลทั่วไปได้'}
              </p>
            </div>
          </div>

          {/* Issue Cards */}
          {issues.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {issues.map((iss) => (
                <div
                  key={iss.id}
                  style={{
                    background: '#f8fafc',
                    borderRadius: 10,
                    border: '1px solid #e2e8f0',
                    padding: '8px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {iss.type === 'ph' && <Droplets size={13} className="text-amber-600" />}
                    {iss.type === 'ec' && <Zap size={13} className="text-blue-600" />}
                    {iss.type === 'tds' && <Droplets size={13} className="text-teal-600" />}
                    {iss.type === 'temp' && <Thermometer size={13} className="text-rose-600" />}
                    {iss.type === 'connection' && <WifiOff size={13} className="text-red-600" />}
                    {iss.type === 'sensor' && <Activity size={13} className="text-amber-600" />}
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: '#334155' }}>{iss.title}</span>
                  </div>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      color: iss.severity === 'danger' ? '#dc2626' : '#d97706',
                      background: iss.severity === 'danger' ? '#fef2f2' : '#fffbeb',
                      padding: '1px 6px',
                      borderRadius: 4,
                    }}
                  >
                    {iss.currentVal}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Manual copy fallback: clipboard unavailable -> let the user select the text */}
          {manualCopy && (
            <div
              style={{
                background: '#f8fafc',
                border: '1px solid #cbd5e1',
                borderRadius: 12,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>
                คัดลอกอัตโนมัติไม่สำเร็จ
              </span>
              <span style={{ fontSize: 11, color: '#475569', lineHeight: 1.4 }}>
                กดค้างที่ข้อความด้านล่างเพื่อเลือกและคัดลอกเอง แล้วกดเลือกแอป AI เพื่อเปิดและวางข้อความ
              </span>
              <textarea
                readOnly
                value={generatedPrompt}
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  width: '100%',
                  minHeight: 140,
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: '#334155',
                  background: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  padding: 8,
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
            </div>
          )}

          {/* AI Apps Selector Options */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <Share2 size={14} className="text-emerald-600" />
              <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>
                เลือกแอป AI ภายนอก (เปิดในเบราว์เซอร์ • แอปไม่ได้วิเคราะห์ด้วย AI เอง)
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* ChatGPT */}
              <button
                type="button"
                onClick={() => handleLaunchAI('chatgpt')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #10b981',
                  background: '#f0fdf4',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: '#10a37f',
                      color: '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: 14,
                    }}
                  >
                    G
                  </div>
                  <div>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#065f46', display: 'block' }}>
                      ChatGPT
                    </span>
                    <span style={{ fontSize: 10.5, color: '#047857' }}>
                      เปิด chatgpt.com พร้อมคัดลอกข้อความ
                    </span>
                  </div>
                </div>
                <ExternalLink size={15} className="text-emerald-700" />
              </button>

              {/* Google Gemini */}
              <button
                type="button"
                onClick={() => handleLaunchAI('gemini')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #60a5fa',
                  background: '#eff6ff',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
                      color: '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Sparkles size={16} />
                  </div>
                  <div>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#1e40af', display: 'block' }}>
                      Google Gemini
                    </span>
                    <span style={{ fontSize: 10.5, color: '#2563eb' }}>
                      เปิด gemini.google.com พร้อมคัดลอกข้อความ
                    </span>
                  </div>
                </div>
                <ExternalLink size={15} className="text-blue-700" />
              </button>

              {/* Claude */}
              <button
                type="button"
                onClick={() => handleLaunchAI('claude')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #c084fc',
                  background: '#faf5ff',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: '#9333ea',
                      color: '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: 14,
                    }}
                  >
                    C
                  </div>
                  <div>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#6b21a8', display: 'block' }}>
                      Claude AI
                    </span>
                    <span style={{ fontSize: 10.5, color: '#7e22ce' }}>
                      เปิด claude.ai พร้อมคัดลอกข้อความ
                    </span>
                  </div>
                </div>
                <ExternalLink size={15} className="text-purple-700" />
              </button>

              {/* Copy Only */}
              <button
                type="button"
                onClick={() => copyPromptToClipboard()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '9px 12px',
                  minHeight: 44,
                  borderRadius: 10,
                  border: '1px solid #cbd5e1',
                  background: '#ffffff',
                  color: '#475569',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <Copy size={13} />
                <span>{manualCopy ? 'ลองคัดลอกอัตโนมัติอีกครั้ง' : 'คัดลอกข้อความอย่างเดียว (ไปวางในแอปอื่น)'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
