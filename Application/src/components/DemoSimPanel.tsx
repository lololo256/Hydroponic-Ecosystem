import { useState } from 'react';
import { useSmartFarm } from '../context/SmartFarmContext';

/**
 * "ทดสอบระบบอัตโนมัติ" — ส่งค่าน้ำทดสอบเข้าบอร์ดทดลองจริง (บอร์ดจอ CYD ที่คอมไพล์ DEMO_SIM=1)
 * ผ่าน RPC `simSet` -> บอร์ดเปลี่ยนค่า pH / EC / อุณหภูมิในตัวเอง แล้วโหมด AUTO บนบอร์ดจะจ่ายปั๊มตามค่าใหม่
 * (เห็นปั๊มทำงานบนจอบอร์ด และค่าใหม่กลับมาที่แอปผ่าน ThingsBoard ตามปกติ)
 *
 * แสดงเฉพาะบอร์ดที่ส่ง `sim:true` เท่านั้น — บอร์ดจริงของแอปหลัก (เซนเซอร์จริง เช่น FARM-01)
 * ไม่ส่ง sim จึงไม่เห็นกล่องนี้ และเฟิร์มแวร์บอร์ดจริงก็ไม่รับคำสั่ง simSet
 * วางไว้บนสุดของหน้าแดชบอร์ด (HomeScreen) เพื่อให้อาจารย์หาเจอง่าย
 */
export default function DemoSimPanel() {
  const { data, setDemoSimValues, canControl, connectedBoardId, telemetryFreshness } = useSmartFarm();
  const [simPh, setSimPh] = useState('');
  const [simEc, setSimEc] = useState('');
  const [simTemp, setSimTemp] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!data.device?.isSim) return null;

  const locked = !canControl;
  const lockReason = !connectedBoardId
    ? 'ยังไม่ได้เชื่อมต่ออุปกรณ์'
    : telemetryFreshness === 'loading'
    ? 'กำลังโหลดสถานะอุปกรณ์'
    : telemetryFreshness === 'stale'
    ? 'ข้อมูลเริ่มเก่า รอให้อุปกรณ์ส่งค่าสดก่อนจึงสั่งงานได้'
    : 'อุปกรณ์ออฟไลน์ ไม่สามารถส่งคำสั่งได้';

  const apply = async () => {
    const num = (s: string) => {
      const t = s.trim().replace(',', '.');
      if (!t) return undefined;
      const v = Number(t);
      return Number.isFinite(v) ? v : undefined;
    };
    setBusy(true);
    setMessage(null);
    try {
      const res = await setDemoSimValues({ ph: num(simPh), ec: num(simEc), temp: num(simTemp) });
      setMessage({ ok: res.success, text: res.message });
      if (res.success) {
        setSimPh('');
        setSimEc('');
        setSimTemp('');
      }
    } finally {
      setBusy(false);
    }
  };

  const disabled = locked || busy;

  return (
    <div className="glass-card" style={{ padding: '16px', border: '1px solid #99f6e4' }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', margin: '0 0 4px' }}>ทดสอบระบบอัตโนมัติ</h3>
      <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 12px', lineHeight: 1.5 }}>
        ส่งค่าน้ำทดสอบเข้าบอร์ดทดลอง ใส่ค่าที่ต่ำหรือสูงกว่าช่วงที่ตั้งไว้ แล้วเปิดโหมดอัตโนมัติ อุปกรณ์จะตรวจภายใน
        30 วินาที แล้วจ่ายปั๊มทีละตัว ตัวละ 2 วินาที และผสม 5 นาที ดูปั๊มที่ทำงานได้บนจออุปกรณ์
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
        {[
          { label: 'pH', value: simPh, set: setSimPh, ph: 'เช่น 7.2' },
          { label: 'EC (mS/cm)', value: simEc, set: setSimEc, ph: 'เช่น 1.0' },
          { label: 'อุณหภูมิ (°C)', value: simTemp, set: setSimTemp, ph: 'เช่น 30' },
        ].map((f) => (
          <label key={f.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>{f.label}</span>
            <input
              type="text"
              inputMode="decimal"
              value={f.value}
              placeholder={f.ph}
              onChange={(e) => f.set(e.target.value)}
              style={{
                width: '100%',
                minHeight: 44,
                padding: '0 10px',
                borderRadius: 10,
                border: '1px solid #cbd5e1',
                fontSize: 14,
                color: '#0f172a',
                background: '#ffffff',
                boxSizing: 'border-box',
              }}
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          if (!disabled) void apply();
        }}
        disabled={disabled}
        title={locked ? lockReason : undefined}
        style={{
          width: '100%',
          minHeight: 44,
          borderRadius: 12,
          border: 'none',
          background: disabled ? '#cbd5e1' : '#0f766e',
          color: '#ffffff',
          fontSize: 13,
          fontWeight: 600,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {busy ? 'กำลังส่งค่า...' : 'ส่งค่าทดสอบ'}
      </button>
      {locked && (
        <p style={{ fontSize: 11, color: '#b45309', margin: '8px 0 0' }}>{lockReason}</p>
      )}
      {message && (
        <p role="status" style={{ fontSize: 11, color: message.ok ? '#047857' : '#b91c1c', margin: '8px 0 0' }}>
          {message.text}
        </p>
      )}
    </div>
  );
}
