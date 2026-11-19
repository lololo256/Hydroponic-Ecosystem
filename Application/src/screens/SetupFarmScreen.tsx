import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';
import {
  Calendar,
  Sprout,
  Clock,
  BookOpen,
  Check,
  AlertTriangle,
  Sparkles,
  RefreshCw,
  X,
  Info,
  Sliders,
  ShieldAlert,
  Loader2,
} from 'lucide-react';
import {
  getPlantProfile,
  mergePlantTargets,
  callGeminiPrompt,
  isValidPlantQuery,
  PlantLockedError,
  isCustomPlantAiEnabled,
  type PlantProfile,
  type MergedPlantTargets,
} from '../services/plantProfileService';

const PLANT_TEMPLATES = [
  {
    id: 'lettuce',
    name: 'ผักกาดหอม (Lettuce)',
    ph: [5.5, 6.5],
    ec: [1.2, 1.8],
    color: '#10b981',
    harvestDays: 45,
    researchNote: 'ค่าแนะนำจากฐานข้อมูลพืชในแอป: pH 5.5-6.5 และ EC 1.2-1.8',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22v-6" />
        <path d="M12 16a4 4 0 0 0-4-4H5.5a2.5 2.5 0 0 0-2.5 2.5V16h9Z" />
        <path d="M12 16a4 4 0 0 1 4-4h2.5a2.5 2.5 0 0 1 2.5 2.5V16h-9Z" />
        <path d="M12 12a4 4 0 0 0-4-4H5.5a2.5 2.5 0 0 0-2.5 2.5V12h9Z" />
        <path d="M12 12a4 4 0 0 1 4-4h2.5a2.5 2.5 0 0 1 2.5 2.5V12h-9Z" />
      </svg>
    ),
  },
  {
    id: 'cos',
    name: 'สลัดคอส (Cos)',
    ph: [5.5, 6.5],
    ec: [1.2, 1.8],
    color: '#10b981',
    harvestDays: 45,
    researchNote: 'ต้องการแสงสม่ำเสมอ ค่า EC 1.4-1.8 เหมาะกับสภาพอากาศเขตร้อนชื้น',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22v-5" />
        <path d="M9 8a3 3 0 0 0-3 3v6h6V8Z" />
        <path d="M15 8a3 3 0 0 1 3 3v6H12V8Z" />
        <path d="M12 8a3 3 0 0 0-3-3V2h6v3a3 3 0 0 0-3 3Z" />
      </svg>
    ),
  },
  {
    id: 'greenoak',
    name: 'กรีนโอ๊ค (Green Oak)',
    ph: [5.8, 6.5],
    ec: [1.4, 1.8],
    color: '#10b981',
    harvestDays: 40,
    researchNote: 'ผักสลัดยอดนิยม โตไวใน 40-45 วัน ควรคุมอุณหภูมิน้ำต่ำกว่า 28°C ป้องกันปลายใบไหม้',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
        <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
        <path d="M12 22v-9.5" />
      </svg>
    ),
  },
  {
    id: 'redoak',
    name: 'เรดโอ๊ค (Red Oak)',
    ph: [5.8, 6.5],
    ec: [1.4, 1.8],
    color: '#10b981',
    harvestDays: 42,
    researchNote: 'สร้างสารแอนโทไซยานินได้ดีใน pH 6.0 และ EC 1.4-1.8 สภาพน้ำเย็น',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
        <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
        <path d="M12 22v-9.5" />
      </svg>
    ),
  },
  {
    id: 'morningglory',
    name: 'ผักบุ้ง (Morning Glory)',
    ph: [6.0, 7.0],
    ec: [1.5, 2.2],
    color: '#10b981',
    harvestDays: 22,
    researchNote: 'พืชโตไวมาก เก็บเกี่ยวได้ใน 20-25 วัน ทนร้อนได้ดี ต้องการปุ๋ยเข้มข้น (EC 1.6-2.2)',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22v-8" />
        <path d="M12 14c-4.2-1.7-6-5-6-9 2.4.8 4 3 6 9Z" />
        <path d="M12 14c4.2-1.7 6-5 6-9-2.4.8-4 3-6 9Z" />
      </svg>
    ),
  },
  {
    id: 'kale',
    name: 'เคล (Kale)',
    ph: [5.5, 6.5],
    ec: [1.8, 2.5],
    color: '#10b981',
    harvestDays: 55,
    researchNote: 'ราชินีผักใบเขียว ต้องการไนโตรเจนสูง EC 1.8-2.5 เพื่อสร้างใบหนาและคุณค่าอาหารสูง',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22v-4" />
        <path d="M12 18a4 4 0 0 0-4-4H6a2 2 0 0 0-2 2v2h8Z" />
        <path d="M12 18a4 4 0 0 1 4-4h2a2 2 0 0 1 2 2v2h-8Z" />
        <path d="M12 14a4 4 0 0 0-4-4H6a2 2 0 0 0-2 2v2h8Z" />
        <path d="M12 14a4 4 0 0 1 4-4h2a2 2 0 0 1 2 2v2h-8Z" />
      </svg>
    ),
  },
  {
    id: 'celery',
    name: 'คื่นฉ่าย (Celery)',
    ph: [6.0, 6.5],
    ec: [1.8, 2.4],
    color: '#10b981',
    harvestDays: 60,
    researchNote: 'ต้องการน้ำหมุนเวียนต่อเนื่องและ pH คงที่ที่ 6.2-6.5 เพื่อก้านกรอบไม่ขม',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 22v-7" />
        <path d="M14 22v-9" />
        <path d="M10 15c-3-2-5-5-5-8 2 1 4 3 5 8Z" />
        <path d="M14 13c3-2 5-5 5-8-2 1-4 3-5 8Z" />
      </svg>
    ),
  },
  {
    id: 'other',
    name: 'อื่นๆ (พิมพ์ชื่อพืช)',
    ph: [5.5, 6.5],
    ec: [1.4, 2.0],
    color: '#10b981',
    harvestDays: 45,
    researchNote: 'พิมพ์ชื่อพืชเอง ให้ AI (Gemini) ประมาณค่า pH/EC/วันเก็บเกี่ยว เมื่อใส่ API Key ในตั้งค่าแอปแล้ว',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v8" />
        <path d="M8 12h8" />
      </svg>
    ),
  },
];

const getTodayDateStr = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export default function SetupFarmScreen({ navigate, goBack }: NavProps) {
  const { data, updatePlantType, updateTargets, showAlert, connectedBoardId } = useSmartFarm();
  // re-read on every render: the key can be added in app settings and the user comes back here
  const aiEnabled = isCustomPlantAiEnabled();

  // Strict UI Gating: Redirect to home if no device is connected
  // (the early `return null` lives below all hooks so the hook order never changes)
  useEffect(() => {
    if (!connectedBoardId) {
      if (goBack) goBack('home');
      else navigate('home');
    }
  }, [connectedBoardId, goBack, navigate]);

  // ── States ──
  const [selectedPlants, setSelectedPlants] = useState<string[]>([]);
  const [customName, setCustomName] = useState('');
  const [plantingDate, setPlantingDate] = useState<string>(() => {
    if (data.plantingStartDate) {
      const d = new Date(data.plantingStartDate);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return getTodayDateStr();
  });

  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('กำลังดึงค่าแนะนำจากฐานข้อมูลพืชในแอป...');
  const [plantProfiles, setPlantProfiles] = useState<PlantProfile[]>([]);
  const [mergedResult, setMergedResult] = useState<MergedPlantTargets | null>(null);

  // Editable Targets
  const [targetPHMin, setTargetPHMin] = useState<number>(data.targets?.phMin ?? 5.8);
  const [targetPHMax, setTargetPHMax] = useState<number>(data.targets?.phMax ?? 6.5);
  const [targetECMin, setTargetECMin] = useState<number>(data.targets?.ecMin ?? 1.4);
  const [targetECMax, setTargetECMax] = useState<number>(data.targets?.ecMax ?? 1.8);
  const [targetTempMin, setTargetTempMin] = useState<number>(data.targets?.tempMin ?? 22.0);
  const [targetTempMax, setTargetTempMax] = useState<number>(data.targets?.tempMax ?? 28.0);
  const [harvestDays, setHarvestDays] = useState<number>(data.expectedHarvestDays ?? 40);
  const [isCustomizing, setIsCustomizing] = useState(false);

  // Confirm dialog + save state (no time lock: a wrong pick can be fixed right away)
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isComposingRef = useRef(false);

  // Lock body scroll and prevent background gesture leakage when confirm modal is open
  useEffect(() => {
    if (showConfirmModal) {
      const origOverflow = document.body.style.overflow;
      const origTouchAction = document.body.style.touchAction;
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
      return () => {
        document.body.style.overflow = origOverflow;
        document.body.style.touchAction = origTouchAction;
      };
    }
  }, [showConfirmModal]);


  // Auto-select existing crops and restore active targets if already configured
  useEffect(() => {
    if (data.plantType && selectedPlants.length === 0) {
      const foundIds: string[] = [];
      PLANT_TEMPLATES.forEach((p) => {
        const baseName = p.name.split(' (')[0];
        if (data.plantType?.includes(baseName)) {
          foundIds.push(p.id);
        }
      });
      if (foundIds.length > 0) {
        setSelectedPlants(foundIds);
      } else {
        setSelectedPlants(['other']);
        setCustomName(data.plantType);
      }

      // ซิงก์เป้าหมายรอบปลูกปัจจุบันจาก Cloud อัตโนมัติ (Single Source of Truth)
      const phMin = data.targetPHMin ?? data.targets?.phMin ?? 5.8;
      const phMax = data.targetPHMax ?? data.targets?.phMax ?? 6.5;
      const ecMin = data.targetECMin ?? data.targets?.ecMin ?? 1.4;
      const ecMax = data.targetECMax ?? data.targets?.ecMax ?? 1.8;
      const tempMin = data.targetTempMin ?? data.targets?.tempMin ?? 22.0;
      const tempMax = data.targetTempMax ?? data.targets?.tempMax ?? 28.0;
      const harvest = data.expectedHarvestDays ?? 40;

      setMergedResult({
        phMin,
        phMax,
        ecMin,
        ecMax,
        tempMin,
        tempMax,
        harvestDays: harvest,
        conflict: false,
        disadvantagedPlants: [],
        compatiblePlantNames: [data.plantType],
      });

      const startDateFormatted = data.plantingStartDate
        ? new Date(data.plantingStartDate).toLocaleDateString('th-TH')
        : 'วันนี้';

      setPlantProfiles([
        {
          recognized: true,
          canonical_name_th: data.plantType,
          canonical_name_en: 'Active Crop',
          hydroponic_suitable: true,
          harvest_days: { min: harvest, max: harvest },
          ph: { min: phMin, max: phMax },
          ec_ms_cm: { min: ecMin, max: ecMax },
          water_temp_c: { min: tempMin, max: tempMax },
          confidence: 'high',
          notes: `รอบการปลูกปัจจุบันของอุปกรณ์ เริ่มปลูกเมื่อ ${startDateFormatted}`,
        },
      ]);
    }
  }, [data.plantType, data.plantingStartDate, data.targets]);

  // A new plant name invalidates the previous result: otherwise "confirm" would save the new name
  // with the old plant's pH/EC targets (and the analyze button stays hidden).
  const changeCustomName = (value: string) => {
    if (customName.trim() !== value.trim()) {
      setMergedResult(null);
      setPlantProfiles([]);
    }
    setCustomName(value);
  };

  const togglePlant = (id: string) => {
    setMergedResult(null);
    setPlantProfiles([]);
    setSelectedPlants((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  // ── 1. Analyze and Research with AI Engine ──
  const handleAnalyze = async () => {
    if (selectedPlants.length === 0) return;
    setLoading(true);
    setLoadingText('กำลังดึงค่าแนะนำจากฐานข้อมูลพืชในแอป...');
    setMergedResult(null);

    try {
      const profiles: PlantProfile[] = [];

      for (const id of selectedPlants) {
        if (id === 'other') {
          const rawCustom = customName.trim();
          if (!rawCustom) {
            setLoading(false);
            showAlert({
              title: 'กรุณาระบุชื่อพืช',
              message: 'โปรดพิมพ์ชื่อพืชที่ต้องการปลูกเพิ่มเติมในช่องข้อความ',
              variant: 'warning',
            });
            return;
          }

          // Anti-Gibberish & Sanity Check ก่อนยิง AI
          const validation = isValidPlantQuery(rawCustom);
          if (!validation.valid) {
            setLoading(false);
            showAlert({
              title: 'ชื่อพืชไม่ถูกต้อง',
              message: validation.reason || 'กรุณาระบุชื่อพืชจริงที่ถูกต้องสำหรับการปลูกไฮโดรโปนิกส์ (ห้ามพิมพ์ตัวอักษรซ้ำ หรือข้อความสุ่ม)',
              variant: 'warning',
            });
            return;
          }

          try {
            if (aiEnabled) {
              setLoadingText(`กำลังขอค่าประมาณจาก AI ภายนอกสำหรับ "${rawCustom}"...`);
              // getPlantProfile builds the plant prompt itself -> send it as is (no second template)
              const p = await getPlantProfile(rawCustom, (prompt) => callGeminiPrompt(prompt));
              profiles.push(p);
            } else {
              // AI off: built-in table / cache only (an unknown plant is reported as unrecognized)
              const p = await getPlantProfile(rawCustom);
              profiles.push(p);
            }
          } catch (err: any) {
            if (err instanceof PlantLockedError) {
              setLoading(false);
              showAlert({
                title: 'วิเคราะห์พืชใหม่ด้วย AI ได้อีกครั้งหลังเที่ยงคืน',
                message: `${err.message} หรือเลือกพืชจากรายการในแอปได้ทันที`,
                variant: 'warning',
              });
              return;
            }
            throw err;
          }
        } else {
          // Template plant
          const tpl = PLANT_TEMPLATES.find((p) => p.id === id);
          const baseName = tpl?.name.split(' (')[0] || '';
          const p = await getPlantProfile(baseName);
          profiles.push(p);
        }
      }

      setPlantProfiles(profiles);

      // Merge profiles and detect conflicts
      const merged = mergePlantTargets(profiles);
      setMergedResult(merged);

      // Initialize editable target inputs
      setTargetPHMin(merged.phMin);
      setTargetPHMax(merged.phMax);
      setTargetECMin(merged.ecMin);
      setTargetECMax(merged.ecMax);
      setTargetTempMin(merged.tempMin);
      setTargetTempMax(merged.tempMax);
      setHarvestDays(merged.harvestDays);
    } catch (err: any) {
      console.error('Plant research error:', err);
      showAlert({
        title: 'ดึงค่าแนะนำไม่สำเร็จ',
        message: err.message || 'ไม่สามารถดึงค่าแนะนำของพืชได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง',
        variant: 'danger',
      });
    } finally {
      setLoading(false);
    }
  };

  // ── 3. Confirm and Start Crop Season (save first; report failures; no time lock) ──
  const handleConfirmAndStart = async () => {
    if (isSaving) return;
    const plantNames = selectedPlants
      .map((id) => {
        if (id === 'other') return customName.trim() || 'พืชทั่วไป';
        return PLANT_TEMPLATES.find((p) => p.id === id)?.name?.split(' (')[0] || '';
      })
      .filter(Boolean)
      .join(' + ');

    const plantingTimestamp = new Date(`${plantingDate}T00:00:00`).getTime();

    setIsSaving(true);
    try {
      // 1. Update Farm Context & ThingsBoard Shared Attributes (throws on save failure)
      await updatePlantType(
        plantNames,
        {
          targetPHMin,
          targetPHMax,
          targetECMin,
          targetECMax,
        },
        plantingTimestamp,
        harvestDays
      );

      await updateTargets({
        phMin: targetPHMin,
        phMax: targetPHMax,
        ecMin: targetECMin,
        ecMax: targetECMax,
        tempMin: targetTempMin,
        tempMax: targetTempMax,
      });
    } catch (err: any) {
      console.error('Start crop season failed:', err);
      setIsSaving(false);
      showAlert({
        title: 'บันทึกไม่สำเร็จ',
        message: `${err?.message || 'ไม่สามารถบันทึกข้อมูลรอบปลูกไปยังอุปกรณ์ได้'}\nยังไม่มีการเปลี่ยนแปลงรอบปลูก กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่`,
        variant: 'danger',
      });
      return;
    }

    setIsSaving(false);
    setShowConfirmModal(false);

    showAlert({
      title: 'เริ่มรอบการปลูกแล้ว',
      message: `บันทึก "${plantNames}" เรียบร้อยแล้ว\nเริ่มนับรอบปลูกตั้งแต่วันที่ ${plantingDate} (แก้ไขได้ทุกเมื่อจากหน้านี้)`,
      variant: 'success',
    });

    if (goBack) {
      goBack('home');
    } else {
      navigate('home');
    }
  };

  // Estimated harvest date calculation
  const estimatedDateStr = useMemo(() => {
    const pDate = new Date(`${plantingDate}T00:00:00`);
    const estDate = new Date(pDate.getTime() + harvestDays * 24 * 60 * 60 * 1000);
    return `${estDate.getDate()} ${estDate.toLocaleDateString('th-TH', { month: 'short' })} ${estDate.getFullYear() + 543}`;
  }, [plantingDate, harvestDays]);

  // Current crop age
  const plantTimeMs = new Date(`${plantingDate}T00:00:00`).getTime();
  const currentAgeDays = Math.max(1, Math.floor((Date.now() - plantTimeMs) / (24 * 60 * 60 * 1000)));

  // "อื่นๆ" is always offered: with a Gemini key the AI estimates pH/EC for the typed plant,
  // without one the typed name is looked up in the in-app plant table only.
  const visibleTemplates = PLANT_TEMPLATES;

  if (!connectedBoardId) {
    return null;
  }

  return (
    <div
      className="fade-in"
      style={{
        width: '100%',
        minHeight: '100%',
        background: '#f8fafc',
        paddingTop: 48,
        paddingLeft: 16,
        paddingRight: 16,
        paddingBottom: 24,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        boxSizing: 'border-box',
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
      }}
    >
      {/* Back Button */}
      <button
        onClick={() => (goBack ? goBack('home') : navigate('home'))}
        style={{
          position: 'absolute',
          top: 48,
          left: 16,
          background: 'white',
          border: '1px solid #e2e8f0',
          borderRadius: 12,
          width: 38,
          height: 38,
          cursor: 'pointer',
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
          fontSize: 16,
          color: '#475569',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10,
        }}
      >
        ←
      </button>

      {/* Screen Header */}
      <div style={{ textAlign: 'center', marginBottom: 20, marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8, color: '#059669' }}>
          <Sprout size={36} strokeWidth={2} />
        </div>
        <h1 style={{ fontFamily: 'Nunito,sans-serif', fontSize: 22, fontWeight: 900, color: '#0f172a', margin: '0 0 6px' }}>
          ตั้งค่าระบบพืช & ฟาร์ม
        </h1>
        <p style={{ fontSize: 13, color: '#64748b', margin: 0, lineHeight: 1.5 }}>
          เลือกชนิดพืช แล้วใช้ค่าแนะนำจากฐานข้อมูลพืชในแอปเป็นเป้าหมาย pH/EC (ปรับตัวเลขเองได้)
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* ── 1. Planting Date Section ── */}
        <div
          style={{
            background: '#ffffff',
            borderRadius: 16,
            border: '1px solid #e2e8f0',
            padding: '16px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.03)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Calendar size={18} className="text-emerald-600" />
              <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>วันที่เริ่มปลูก</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setPlantingDate(getTodayDateStr());
                setMergedResult(null);
              }}
              style={{
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 8,
                border: plantingDate === getTodayDateStr() ? '1px solid #059669' : '1px solid #e2e8f0',
                background: plantingDate === getTodayDateStr() ? '#ecfdf5' : '#f8fafc',
                color: plantingDate === getTodayDateStr() ? '#059669' : '#64748b',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              วันนี้
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="date"
              value={plantingDate}
              onChange={(e) => {
                setPlantingDate(e.target.value);
                setMergedResult(null);
              }}
              style={{
                flex: 1,
                padding: '10px 14px',
                borderRadius: 12,
                border: '1.5px solid #e2e8f0',
                fontSize: 14,
                fontWeight: 600,
                color: '#0f172a',
                outline: 'none',
                background: '#f8fafc',
                fontFamily: 'inherit',
              }}
            />
            <div
              style={{
                padding: '8px 12px',
                background: '#f0fdf4',
                borderRadius: 12,
                border: '1px solid #dcfce7',
                textAlign: 'center',
                flexShrink: 0,
              }}
            >
              <div style={{ fontSize: 10, color: '#166534', fontWeight: 600 }}>อายุผัก</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#15803d', fontFamily: 'monospace' }}>
                {currentAgeDays} วัน
              </div>
            </div>
          </div>
        </div>

        {/* ── 2. Crop Selection Grid ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
            เลือกชนิดพืชที่ปลูก (เลือกผสมกันได้)
          </span>
          <span style={{ fontSize: 11, color: '#64748b' }}>เลือกแล้ว {selectedPlants.length} ชนิด</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {visibleTemplates.map((plant) => {
            const isSelected = selectedPlants.includes(plant.id);
            return (
              <div
                key={plant.id}
                onClick={() => togglePlant(plant.id)}
                style={{
                  background: isSelected ? '#ecfdf5' : 'white',
                  border: `2px solid ${isSelected ? '#10b981' : '#e2e8f0'}`,
                  borderRadius: 16,
                  padding: '14px 8px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  boxShadow: isSelected ? '0 4px 12px rgba(16, 185, 129, 0.12)' : '0 1px 3px rgba(0,0,0,0.02)',
                  transition: 'all 0.2s ease',
                  position: 'relative',
                }}
              >
                {isSelected && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      background: '#10b981',
                      color: 'white',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Check size={12} strokeWidth={3} />
                  </div>
                )}
                <div style={{ color: isSelected ? '#10b981' : '#64748b' }}>{plant.icon}</div>
                <p
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: isSelected ? '#065f46' : '#334155',
                    textAlign: 'center',
                    margin: 0,
                  }}
                >
                  {plant.name.split(' (')[0]}
                </p>
                <span style={{ fontSize: 10, color: isSelected ? '#047857' : '#94a3b8' }}>
                  รอบโต ~{plant.harvestDays} วัน
                </span>
              </div>
            );
          })}
        </div>

        {/* ── 2.1 Custom Plant Input ── */}
        {selectedPlants.includes('other') && (
          <div
            className="screen-enter"
            style={{
              background: 'white',
              padding: 16,
              borderRadius: 16,
              border: '1px solid #e2e8f0',
              boxShadow: '0 2px 8px rgba(0,0,0,0.03)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>
                ระบุชื่อพืชเพิ่มเติม (เช่น เมลอน, สตรอเบอร์รี่, มะเขือเทศ)
              </label>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 10.5,
                  color: '#059669',
                  fontWeight: 600,
                }}
              >
                <Sparkles size={12} />
                <span>{aiEnabled ? 'AI (Gemini) ประมาณค่า' : 'ค้นจากฐานข้อมูลในแอป'}</span>
              </div>
            </div>
            {!aiEnabled && (
              <p
                style={{
                  margin: '0 0 8px',
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: '1px solid #fde68a',
                  background: '#fffbeb',
                  color: '#92400e',
                  fontSize: 11.5,
                  lineHeight: 1.5,
                }}
              >
                ขณะนี้ AI วิเคราะห์พืชยังไม่พร้อม จึงค้นได้เฉพาะพืชที่มีในแอป
              </p>
            )}

            <input
              type="text"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={customName}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={(e) => {
                isComposingRef.current = false;
                changeCustomName(e.currentTarget.value);
              }}
              onChange={(e) => {
                changeCustomName(e.target.value);
              }}
              placeholder="เช่น สตรอเบอร์รี่, มะเขือเทศเชอร์รี่, เมลอน"
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 12,
                border: '1.5px solid #e2e8f0',
                fontSize: 14,
                outline: 'none',
                boxSizing: 'border-box',
                background: '#ffffff',
                cursor: 'text',
              }}
            />
          </div>
        )}

        {/* ── Loading Animation ── */}
        {loading && (
          <div className="screen-enter" style={{ marginTop: 16, textAlign: 'center', padding: '20px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <RefreshCw size={36} className="text-emerald-600 animate-spin" />
            </div>
            <p style={{ fontSize: 13.5, fontWeight: 700, color: '#065f46', margin: 0 }}>
              {loadingText}
            </p>
            <span style={{ fontSize: 11, color: '#64748b', marginTop: 4, display: 'block' }}>
              กำลังคำนวณช่วงทับซ้อนและตรวจจับค่าขัดแย้ง...
            </span>
          </div>
        )}

        {/* ── 3. Plant Profile Result Card (built-in plant database) ── */}
        {mergedResult && !loading && (
          <div
            className="screen-enter"
            style={{
              marginTop: 10,
              background: '#ffffff',
              borderRadius: 18,
              border: `1.5px solid ${mergedResult.conflict ? '#fca5a5' : '#a7f3d0'}`,
              padding: '18px 16px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.04)',
            }}
          >
            {/* Compatibility Header */}
            <div
              style={{
                background: mergedResult.conflict ? '#fef2f2' : '#f0fdf4',
                borderRadius: 12,
                padding: '10px 14px',
                marginBottom: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              {mergedResult.conflict ? (
                <ShieldAlert size={22} className="text-red-600 shrink-0" />
              ) : (
                <Check size={22} className="text-emerald-600 shrink-0" />
              )}
              <div>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 800,
                    color: mergedResult.conflict ? '#991b1b' : '#065f46',
                  }}
                >
                  {mergedResult.conflict
                    ? (mergedResult.compatiblePlantNames.length === 0
                        ? 'ไม่สามารถเริ่มรอบการปลูกได้'
                        : 'คำเตือน: ความต้องการปุ๋ยขัดแย้งกัน')
                    : 'พร้อมปลูก! พืชเข้ากันได้ดีเยี่ยม'}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: mergedResult.conflict ? '#b91c1c' : '#047857',
                    marginTop: 2,
                    lineHeight: 1.4,
                  }}
                >
                  {mergedResult.conflict
                    ? mergedResult.warning
                    : 'พืชทั้งหมดต้องการ pH และ EC ในระดับที่ซ้อนทับกันพอดี สามารถปลูกในรางน้ำเดียวกันได้อย่างปลอดภัย'}
                </div>
              </div>
            </div>

            {/* Editable Target Inputs Grid (ซ่อนหากพืชไม่ถูกต้อง) */}
            {mergedResult.compatiblePlantNames.length === 0 ? (
              <div
                style={{
                  background: '#f8fafc',
                  border: '1px dashed #cbd5e1',
                  borderRadius: 14,
                  padding: '16px',
                  textAlign: 'center',
                  color: '#64748b',
                  fontSize: 12.5,
                  marginBottom: 14,
                  lineHeight: 1.5,
                }}
              >
                ระบบไม่สามารถประมวลผลค่าควบคุมน้ำได้เนื่องจากพบพืชที่ไม่รู้จักหรือไม่รองรับ กรุณากดปุ่ม <b>"เลือกใหม่"</b> ด้านล่างเพื่อระบุชนิดพืชจริงที่ถูกต้องครับ
              </div>
            ) : (
              <>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>
                      ค่าเป้าหมายที่คำนวณได้ (ปรับแต่งได้)
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsCustomizing(!isCustomizing)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#059669',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <Sliders size={12} />
                      <span>{isCustomizing ? 'เสร็จสิ้นการปรับแต่ง' : 'ปรับแต่งตัวเลข'}</span>
                    </button>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {/* pH Target */}
                    <div
                      style={{
                        background: '#f8fafc',
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: '1px solid #e2e8f0',
                      }}
                    >
                      <div style={{ fontSize: 10.5, color: '#64748b', fontWeight: 600 }}>เป้าหมาย pH</div>
                      {isCustomizing ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                          <input
                            type="number"
                            step="0.1"
                            value={targetPHMin}
                            onChange={(e) => setTargetPHMin(parseFloat(e.target.value) || 0)}
                            style={{
                              width: '45%',
                              padding: '4px 6px',
                              borderRadius: 6,
                              border: '1px solid #cbd5e1',
                              fontSize: 12,
                              textAlign: 'center',
                            }}
                          />
                          <span>-</span>
                          <input
                            type="number"
                            step="0.1"
                            value={targetPHMax}
                            onChange={(e) => setTargetPHMax(parseFloat(e.target.value) || 0)}
                            style={{
                              width: '45%',
                              padding: '4px 6px',
                              borderRadius: 6,
                              border: '1px solid #cbd5e1',
                              fontSize: 12,
                              textAlign: 'center',
                            }}
                          />
                        </div>
                      ) : (
                        <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', fontFamily: 'monospace', marginTop: 2 }}>
                          {targetPHMin.toFixed(1)} - {targetPHMax.toFixed(1)}
                        </div>
                      )}
                    </div>

                    {/* EC Target */}
                    <div
                      style={{
                        background: '#f8fafc',
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: '1px solid #e2e8f0',
                      }}
                    >
                      <div style={{ fontSize: 10.5, color: '#64748b', fontWeight: 600 }}>เป้าหมาย EC (mS/cm)</div>
                      {isCustomizing ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                          <input
                            type="number"
                            step="0.1"
                            value={targetECMin}
                            onChange={(e) => setTargetECMin(parseFloat(e.target.value) || 0)}
                            style={{
                              width: '45%',
                              padding: '4px 6px',
                              borderRadius: 6,
                              border: '1px solid #cbd5e1',
                              fontSize: 12,
                              textAlign: 'center',
                            }}
                          />
                          <span>-</span>
                          <input
                            type="number"
                            step="0.1"
                            value={targetECMax}
                            onChange={(e) => setTargetECMax(parseFloat(e.target.value) || 0)}
                            style={{
                              width: '45%',
                              padding: '4px 6px',
                              borderRadius: 6,
                              border: '1px solid #cbd5e1',
                              fontSize: 12,
                              textAlign: 'center',
                            }}
                          />
                        </div>
                      ) : (
                        <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', fontFamily: 'monospace', marginTop: 2 }}>
                          {targetECMin.toFixed(1)} - {targetECMax.toFixed(1)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Harvest Days & Date */}
                <div
                  style={{
                    background: '#f0fdf4',
                    border: '1px solid #bbf7d0',
                    borderRadius: 14,
                    padding: '12px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    marginBottom: 12,
                  }}
                >
                  <Clock size={20} className="text-emerald-700 shrink-0" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: '#166534' }}>
                      รอบการปลูก: ประมาณ {harvestDays} วัน
                    </div>
                    <div style={{ fontSize: 11, color: '#15803d', marginTop: 2 }}>
                      คาดว่าจะเก็บเกี่ยวได้: <b>{estimatedDateStr}</b>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Research Notes from Profiles */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {plantProfiles.map((p, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    background: '#f8fafc',
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: '1px solid #f1f5f9',
                  }}
                >
                  <BookOpen size={14} className="text-slate-500 shrink-0 mt-0.5" />
                  <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
                    <b style={{ color: '#334155' }}>{p.canonical_name_th}:</b> {p.notes}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── 4. Bottom Action Floating Bar (Sticky, Safe Area Inset Aware, CLS = 0) ── */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 40,
          background: 'rgba(255, 255, 255, 0.95)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderTop: '1px solid rgba(226, 232, 240, 0.9)',
          boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.06)',
          padding: '12px 16px',
          paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
          marginLeft: -16,
          marginRight: -16,
          marginBottom: -24,
          marginTop: 20,
        }}
      >
        <div style={{ maxWidth: 500, margin: '0 auto', width: '100%' }}>
          {!mergedResult ? (
            <button
              onClick={handleAnalyze}
              disabled={selectedPlants.length === 0 || loading}
              style={{
                width: '100%',
                padding: '14px 24px',
                borderRadius: 16,
                background:
                  selectedPlants.length === 0
                    ? '#e2e8f0'
                    : 'linear-gradient(135deg, #059669, #047857)',
                color: selectedPlants.length === 0 ? '#94a3b8' : 'white',
                fontSize: 15,
                fontWeight: 700,
                border: 'none',
                cursor: selectedPlants.length === 0 ? 'not-allowed' : 'pointer',
                boxShadow:
                  selectedPlants.length === 0
                    ? 'none'
                    : '0 4px 16px rgba(5, 150, 105, 0.25)',
                transition: 'all 0.2s',
              }}
            >
              {loading ? 'กำลังดึงค่าแนะนำ...' : 'ดึงค่าแนะนำของพืช'}
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 10, width: '100%' }}>
              <button
                onClick={() => {
                  setMergedResult(null);
                  setPlantProfiles([]);
                }}
                style={{
                  flex: '0 0 35%',
                  padding: '14px',
                  borderRadius: 16,
                  background: '#f1f5f9',
                  color: '#475569',
                  fontSize: 14,
                  fontWeight: 700,
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                เลือกใหม่
              </button>
              <button
                onClick={() => {
                  if (mergedResult.conflict && mergedResult.compatiblePlantNames.length === 0) {
                    showAlert({
                      title: 'ไม่สามารถเริ่มรอบการปลูกได้',
                      message: mergedResult.warning || 'พบพืชที่ไม่รู้จักหรือไม่เหมาะกับการปลูกในระบบไฮโดรโปนิกส์ กรุณาเลือกพืชใหม่',
                      variant: 'danger',
                    });
                    return;
                  }
                  setShowConfirmModal(true);
                }}
                disabled={mergedResult.conflict && mergedResult.compatiblePlantNames.length === 0}
                style={{
                  flex: 1,
                  padding: '14px 20px',
                  borderRadius: 16,
                  background:
                    mergedResult.conflict && mergedResult.compatiblePlantNames.length === 0
                      ? '#cbd5e1'
                      : 'linear-gradient(135deg, #059669, #047857)',
                  color:
                    mergedResult.conflict && mergedResult.compatiblePlantNames.length === 0
                      ? '#94a3b8'
                      : 'white',
                  fontSize: 15,
                  fontWeight: 700,
                  border: 'none',
                  cursor:
                    mergedResult.conflict && mergedResult.compatiblePlantNames.length === 0
                      ? 'not-allowed'
                      : 'pointer',
                  boxShadow:
                    mergedResult.conflict && mergedResult.compatiblePlantNames.length === 0
                      ? 'none'
                      : '0 4px 16px rgba(5, 150, 105, 0.3)',
                }}
              >
                ยืนยันและเริ่มรอบการปลูก
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── 5. Confirmation Modal Before Planting (Anti-tampering & Quota Saver) ── */}
      {showConfirmModal && typeof document !== 'undefined' && createPortal(
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 999999,
            background: 'rgba(15, 23, 42, 0.72)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            touchAction: 'none',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSaving) setShowConfirmModal(false);
          }}
          onTouchMove={(e) => {
            if (e.target === e.currentTarget) e.preventDefault();
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 420,
              maxHeight: '90vh',
              overflowY: 'auto',
              background: '#ffffff',
              borderRadius: 24,
              boxShadow: '0 25px 50px -12px rgba(0,0,0,0.4)',
              padding: '24px 20px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              touchAction: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: '#fef3c7',
                  color: '#d97706',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <ShieldAlert size={22} />
              </div>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', margin: 0 }}>
                  ยืนยันการตั้งค่าฟาร์ม & เริ่มปลูก
                </h3>
                <span style={{ fontSize: 11.5, color: '#64748b' }}>
                  ตรวจสอบข้อมูลชนิดพืชและค่าเป้าหมาย
                </span>
              </div>
            </div>

            {/* Important Lock Notice */}
            <div
              style={{
                background: '#fffbeb',
                border: '1.5px solid #fde68a',
                borderRadius: 14,
                padding: '12px 14px',
              }}
            >
              <p
                style={{
                  fontSize: 12,
                  color: '#92400e',
                  lineHeight: 1.5,
                  margin: 0,
                  fontWeight: 600,
                }}
              >
                หลังกดยืนยัน แอปจะส่งค่าเป้าหมาย pH/EC ใหม่ไปยังอุปกรณ์ และเริ่มนับอายุผักจากวันที่เริ่มปลูก ตรวจชื่อพืชและตัวเลขให้เรียบร้อยก่อนยืนยัน (แก้ไขภายหลังได้จากหน้านี้)
              </p>
            </div>

            {/* Summary Box */}
            <div
              style={{
                background: '#f8fafc',
                borderRadius: 14,
                border: '1px solid #e2e8f0',
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#64748b' }}>ชนิดพืช:</span>
                <span style={{ fontWeight: 700, color: '#0f172a' }}>
                  {selectedPlants
                    .map((id) => {
                      if (id === 'other') return customName.trim() || 'พืชทั่วไป';
                      return PLANT_TEMPLATES.find((p) => p.id === id)?.name?.split(' (')[0] || '';
                    })
                    .join(' + ')}
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#64748b' }}>เป้าหมาย pH:</span>
                <span style={{ fontWeight: 700, color: '#059669', fontFamily: 'monospace' }}>
                  {targetPHMin.toFixed(1)} - {targetPHMax.toFixed(1)}
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#64748b' }}>เป้าหมาย EC:</span>
                <span style={{ fontWeight: 700, color: '#2563eb', fontFamily: 'monospace' }}>
                  {targetECMin.toFixed(1)} - {targetECMax.toFixed(1)} mS/cm
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#64748b' }}>วันที่เริ่มปลูก:</span>
                <span style={{ fontWeight: 600, color: '#334155' }}>{plantingDate}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#64748b' }}>เก็บเกี่ยวโดยประมาณ:</span>
                <span style={{ fontWeight: 700, color: '#166534' }}>{estimatedDateStr} (~{harvestDays} วัน)</span>
              </div>

              {mergedResult?.conflict && (
                <div
                  style={{
                    marginTop: 4,
                    padding: '6px 8px',
                    borderRadius: 8,
                    background: '#fee2e2',
                    color: '#991b1b',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  <AlertTriangle size={14} className="shrink-0 text-red-700 inline mr-1" />
                  <span>{mergedResult.warning}</span>
                </div>
              )}
            </div>

            {/* Modal Action Buttons */}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                disabled={isSaving}
                style={{
                  flex: 1,
                  padding: '12px',
                  minHeight: 44,
                  borderRadius: 12,
                  border: '1px solid #cbd5e1',
                  background: '#ffffff',
                  color: '#475569',
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: isSaving ? 'not-allowed' : 'pointer',
                  opacity: isSaving ? 0.6 : 1,
                }}
              >
                กลับไปแก้ไข
              </button>
              <button
                type="button"
                onClick={handleConfirmAndStart}
                disabled={isSaving}
                aria-busy={isSaving}
                style={{
                  flex: 1.2,
                  padding: '12px',
                  minHeight: 44,
                  borderRadius: 12,
                  border: 'none',
                  background: isSaving ? '#94a3b8' : 'linear-gradient(135deg, #059669, #047857)',
                  color: '#ffffff',
                  fontSize: 13.5,
                  fontWeight: 700,
                  cursor: isSaving ? 'wait' : 'pointer',
                  boxShadow: isSaving ? 'none' : '0 4px 12px rgba(5, 150, 105, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                {isSaving && <Loader2 size={15} className="animate-spin" />}
                <span>{isSaving ? 'กำลังบันทึก...' : 'ยืนยันและเริ่มปลูก'}</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
