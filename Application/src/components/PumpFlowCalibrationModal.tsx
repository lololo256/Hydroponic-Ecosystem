import React, { useState } from 'react';
import { Beaker, Loader2, Play, X } from 'lucide-react';
import { useSmartFarm, type PumpKey, type SolutionTankKey } from '../context/SmartFarmContext';
import { CALIBRATION_SECONDS } from '../services/solutionTracker';

const TANK_PUMP_KEY: Record<SolutionTankKey, PumpKey> = {
  fertA: 'fertPumpAOn',
  fertB: 'fertPumpBOn',
  phDown: 'phDownPumpOn',
  phUp: 'phUpPumpOn',
};

interface Props {
  tankKey: SolutionTankKey;
  tankLabel: string;
  onClose: () => void;
}

/**
 * Measures a dosing pump's real flow rate: run it for 10 s into a measuring cup, type the ml.
 * The rate is what turns pump run-time into solution used — there is no built-in default.
 */
export default function PumpFlowCalibrationModal({ tankKey, tankLabel, onClose }: Props) {
  const { togglePump, canControl, data, calibratePumpFlow, solutionLevels, pendingPumps } = useSmartFarm();
  const [ran, setRan] = useState(false);
  const [running, setRunning] = useState(false);
  const [measured, setMeasured] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<number | null>(null);

  const pumpKey = TANK_PUMP_KEY[tankKey];
  const isAuto = data.pumps.controlMode === 'AUTO';
  const currentFlow = solutionLevels[tankKey].flowMlPerS;
  const canRun = canControl && !isAuto && !running && !pendingPumps[pumpKey];

  const runPump = async () => {
    setError('');
    setRunning(true);
    try {
      await togglePump(pumpKey, CALIBRATION_SECONDS);
      setRan(true);
    } catch (e: any) {
      setError(e?.message || 'สั่งปั๊มไม่สำเร็จ');
    } finally {
      // the pump keeps running on the board for CALIBRATION_SECONDS; give the user time to watch it
      setTimeout(() => setRunning(false), CALIBRATION_SECONDS * 1000);
    }
  };

  const save = async () => {
    setError('');
    const ml = parseFloat(measured);
    if (!(ml > 0)) return setError('กรุณากรอกปริมาณที่ตวงได้ (มล.)');
    setSaving(true);
    try {
      await calibratePumpFlow(tankKey, ml, CALIBRATION_SECONDS);
      setDone(Math.round((ml / CALIBRATION_SECONDS) * 100) / 100);
      setTimeout(onClose, 1400);
    } catch (e: any) {
      setError(e?.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  };

  const btn = (enabled: boolean, primary = true): React.CSSProperties => ({
    width: '100%',
    minHeight: 48,
    borderRadius: 12,
    border: primary ? 'none' : '1px solid #e2e8f0',
    background: !enabled ? '#e2e8f0' : primary ? '#059669' : '#ffffff',
    color: !enabled ? '#94a3b8' : primary ? '#ffffff' : '#0f172a',
    fontSize: 14,
    fontWeight: 600,
    cursor: enabled ? 'pointer' : 'not-allowed',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 480, background: '#ffffff', borderRadius: '20px 20px 0 0', padding: '20px 18px 28px', boxSizing: 'border-box' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Beaker size={20} color="#059669" />
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#0f172a' }}>วัดอัตราไหลปั๊ม: {tankLabel}</h3>
          </div>
          <button onClick={onClose} aria-label="ปิด" style={{ minWidth: 44, minHeight: 44, border: 'none', background: 'none', cursor: 'pointer', color: '#64748b' }}>
            <X size={20} />
          </button>
        </div>

        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#475569', lineHeight: 1.6 }}>
          ใช้แปลงเวลาที่ปั๊มทำงานเป็นปริมาณสารละลายที่ใช้ไป (ทั้งการกดจ่ายเองและโหมด AUTO)
          {currentFlow !== null ? (
            <>
              <br />
              ค่าปัจจุบัน: <strong>{currentFlow} มล./วินาที</strong>
            </>
          ) : null}
        </p>

        <ol style={{ margin: '0 0 14px', paddingLeft: 20, fontSize: 13, color: '#334155', lineHeight: 1.7 }}>
          <li>ถอดปลายสายปั๊มออกจากถังน้ำวน แล้ววางลงในถ้วยตวง</li>
          <li>กดปุ่มด้านล่าง ปั๊มจะทำงาน {CALIBRATION_SECONDS} วินาที (ต้องอยู่โหมด MANUAL และอุปกรณ์ออนไลน์)</li>
          <li>อ่านปริมาณในถ้วยตวงแล้วกรอกเป็นมิลลิลิตร</li>
        </ol>

        <button disabled={!canRun} onClick={runPump} style={btn(canRun)}>
          {running ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
          <span>{running ? `ปั๊มกำลังทำงาน ${CALIBRATION_SECONDS} วินาที...` : ran ? 'เปิดปั๊มอีกครั้ง' : `เปิดปั๊ม ${CALIBRATION_SECONDS} วินาที`}</span>
        </button>
        {isAuto && (
          <p style={{ margin: '8px 0 0', fontSize: 12, color: '#b45309' }}>อุปกรณ์อยู่โหมด AUTO — เปลี่ยนเป็น MANUAL ก่อนวัด</p>
        )}
        {!canControl && !isAuto && (
          <p style={{ margin: '8px 0 0', fontSize: 12, color: '#b45309' }}>อุปกรณ์ไม่ได้ออนไลน์ — สั่งปั๊มไม่ได้ในขณะนี้</p>
        )}

        <label htmlFor="flow-ml" style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#334155', margin: '16px 0 6px' }}>
          ปริมาณที่ตวงได้ใน {CALIBRATION_SECONDS} วินาที (มล.)
        </label>
        <input
          id="flow-ml"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.5"
          value={measured}
          onChange={(e) => setMeasured(e.target.value)}
          placeholder="เช่น 15"
          style={{ width: '100%', minHeight: 48, padding: '12px 14px', borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 15, boxSizing: 'border-box' }}
        />

        {error && (
          <div role="alert" style={{ marginTop: 10, fontSize: 13, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 12px' }}>
            {error}
          </div>
        )}
        {done !== null && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, padding: '10px 12px' }}>
            บันทึกอัตราไหล {done} มล./วินาที แล้ว
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <button disabled={saving || !measured} onClick={save} style={btn(!saving && Boolean(measured))}>
            {saving && <Loader2 size={18} className="animate-spin" />}
            <span>บันทึกอัตราไหล</span>
          </button>
        </div>
      </div>
    </div>
  );
}
