import { useState, useMemo, useEffect, useRef } from 'react';
import {
  Clock,
  Sparkles,
  Activity,
  ThumbsUp,
  ThumbsDown,
  Check,
  Sunrise,
  Sun,
  Sunset,
  Moon,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  evaluateFarm,
  generateFallbackBriefing,
  generateBriefing,
  saveBriefingFeedback,
  buildUserContext,
  trackAppOpen,
  clearBriefingCache,
  type FarmFacts,
  type UserContext,
} from '../services/briefingEngine';
import { useSmartFarm } from '../context/SmartFarmContext';

interface AIBriefingCardProps {
  plantType?: string;
  plantStartDate?: string | null | number;
  expectedHarvestDays?: number;
  current: {
    pH: number | null;
    ec: number | null;
    tds: number | null;
    tempC: number | null;
    waterLevel?: number | null;
  };
  targets: {
    phMin?: number;
    phMax?: number;
    ecMin?: number;
    ecMax?: number;
    tempMin?: number;
    tempMax?: number;
    tdsMin?: number;
    tdsMax?: number;
  };
  history?: Array<{
    timestamp: number;
    pH?: number | null;
    ec?: number | null;
    tempC?: number | null;
  }>;
  isOnline: boolean;
  prefersReducedMotion?: boolean;
  onOpenAIModal: () => void;
  onOpenSetupFarm: () => void;
}

export default function AIBriefingCard({
  plantType = 'กรีนโอ๊ค',
  plantStartDate,
  expectedHarvestDays,
  current,
  targets,
  history = [],
  isOnline,
  prefersReducedMotion = false,
  onOpenAIModal,
  onOpenSetupFarm,
}: AIBriefingCardProps) {
  const { askGeminiAdvisor } = useSmartFarm();

  // ── 0. Track App Open once per mount & save previousOpenAt ──
  const previousOpenAtRef = useRef<number | null>(null);
  const hasTrackedOpenRef = useRef(false);

  useEffect(() => {
    if (!hasTrackedOpenRef.current) {
      hasTrackedOpenRef.current = true;
      clearBriefingCache();
      const { previousOpenAt } = trackAppOpen();
      previousOpenAtRef.current = previousOpenAt;
    }
  }, []);

  // ── 1. Evaluate Farm (Deterministic Rule Engine) ──
  const initialFacts: FarmFacts = useMemo(() => {
    return evaluateFarm({
      plantType,
      plantStartDate,
      expectedHarvestDays,
      current,
      targets,
      history,
      isOnline,
    });
  }, [plantType, plantStartDate, expectedHarvestDays, current, targets, history, isOnline]);

  const [currentFacts, setCurrentFacts] = useState<FarmFacts>(initialFacts);
  const [briefingText, setBriefingText] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);

  // ── Auto-heal: หากข้อความใน state มีคำภาษาอังกฤษดิบ หรือมีเครื่องหมายก้ามปู [ ] จากบั๊กเก่า ──
  useEffect(() => {
    if (briefingText && (briefingText.includes('[') || briefingText.includes('connectivity'))) {
      clearBriefingCache();
      const userCtx = buildUserContext({ lastOpenAt: previousOpenAtRef.current });
      const freshText = generateFallbackBriefing(initialFacts, userCtx, 'full');
      setBriefingText(freshText);
    }
  }, [briefingText, initialFacts]);

  // ── 2. Run generateBriefing() as Single Entry Point ──
  useEffect(() => {
    let isCancelled = false;
    setIsLoading(true);

    generateBriefing({
      sensors: current,
      targets,
      history,
      plantType,
      plantStartDate,
      expectedHarvestDays,
      isOnline,
      callName: '',
      callAI: async (prompt: string) => {
        if (!askGeminiAdvisor) {
          throw new Error('AI Advisor not available');
        }
        const res = await askGeminiAdvisor(prompt);
        if (res.error || !res.answer) {
          throw new Error(res.error || 'No AI response');
        }
        return res.answer;
      },
      previousOpenAt: previousOpenAtRef.current,
    })
      .then((res) => {
        if (!isCancelled) {
          setBriefingText(res.text);
          setCurrentFacts(res.facts);
          setIsLoading(false);
        }
      })
      .catch((_) => {
        if (!isCancelled) {
          const userCtx = buildUserContext({ lastOpenAt: previousOpenAtRef.current });
          const fallback = generateFallbackBriefing(initialFacts, userCtx, 'full');
          setBriefingText(fallback);
          setCurrentFacts(initialFacts);
          setIsLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [initialFacts.dataHash]);

  // ── 3. Feedback States (ThumbsUp / ThumbsDown) ──
  const [feedbackGiven, setFeedbackGiven] = useState<'up' | 'down' | null>(null);
  const [showDownvoteReasons, setShowDownvoteReasons] = useState(false);
  const [feedbackToast, setFeedbackToast] = useState<string | null>(null);

  const downvoteReasons = ['ผิดข้อมูล', 'ยาวไป', 'ไม่ช่วยอะไร', 'ข้อมูลไม่ตรงเซนเซอร์'];

  const handleThumbUp = () => {
    if (feedbackGiven) return;
    setFeedbackGiven('up');
    saveBriefingFeedback({
      id: `fb_${Date.now()}`,
      timestamp: Date.now(),
      briefingHash: currentFacts.dataHash,
      rating: 'up',
      factsSnapshot: {
        ec: currentFacts.sensors.ec.value,
        tds: currentFacts.sensors.tds.value,
        ph: currentFacts.sensors.pH.value,
        tempC: currentFacts.sensors.tempC.value,
        status: currentFacts.overallStatus,
      },
      message: briefingText,
    });
    setFeedbackToast('บันทึกคำติชมไว้ในเครื่องนี้แล้ว');
    setTimeout(() => setFeedbackToast(null), 2500);
  };

  const handleThumbDownClick = () => {
    if (feedbackGiven) return;
    setShowDownvoteReasons(true);
  };

  const handleSelectDownvoteReason = (reason: string) => {
    setFeedbackGiven('down');
    setShowDownvoteReasons(false);
    saveBriefingFeedback({
      id: `fb_${Date.now()}`,
      timestamp: Date.now(),
      briefingHash: currentFacts.dataHash,
      rating: 'down',
      reason,
      factsSnapshot: {
        ec: currentFacts.sensors.ec.value,
        tds: currentFacts.sensors.tds.value,
        ph: currentFacts.sensors.pH.value,
        tempC: currentFacts.sensors.tempC.value,
        status: currentFacts.overallStatus,
      },
      message: briefingText,
    });
    setFeedbackToast(`บันทึกคำติชม "${reason}" ไว้ในเครื่องนี้แล้ว`);
    setTimeout(() => setFeedbackToast(null), 3000);
  };

  // ── 4. Calculate Growth Stage Progress ──
  // ไม่ทราบรอบเก็บเกี่ยว -> ไม่คำนวณเปอร์เซ็นต์ (แสดง '--')
  const hasHarvestCycle = typeof expectedHarvestDays === 'number' && expectedHarvestDays > 0;
  const growthPercent: number | null = hasHarvestCycle
    ? Math.min(100, Math.round((currentFacts.plantDays / (expectedHarvestDays as number)) * 100))
    : null;
  const harvestCycleLabel = hasHarvestCycle ? String(expectedHarvestDays) : '--';
  const harvestRemainingLabel =
    currentFacts.harvestDaysRemaining !== null ? String(currentFacts.harvestDaysRemaining) : '--';
  const growthPercentLabel = growthPercent !== null ? `${growthPercent}%` : '--';
  const isNoData = currentFacts.overallStatus === 'no_data';

  const renderTimeIcon = () => {
    switch (currentFacts.timeOfDay) {
      case 'morning':
        return <Sunrise size={13} className="text-amber-500" />;
      case 'noon':
        return <Sun size={13} className="text-orange-500" />;
      case 'afternoon':
        return <Sunset size={13} className="text-rose-500" />;
      case 'late_night':
      case 'night':
      default:
        return <Moon size={13} className="text-indigo-400" />;
    }
  };

  const cardBg =
    currentFacts.overallStatus === 'danger'
      ? '#fff5f5'
      : currentFacts.overallStatus === 'warning'
        ? '#fffbeb'
        : isNoData
          ? '#f8fafc'
          : '#f0fdf4';

  const cardBorder =
    currentFacts.overallStatus === 'danger'
      ? '#fecaca'
      : currentFacts.overallStatus === 'warning'
        ? '#fde68a'
        : isNoData
          ? '#e2e8f0'
          : '#bbf7d0';

  const speechText =
    currentFacts.overallStatus === 'danger'
      ? '#991b1b'
      : currentFacts.overallStatus === 'warning'
        ? '#92400e'
        : isNoData
          ? '#475569'
          : '#166534';

  return (
    <div
      style={{
        background: '#ffffff',
        borderRadius: 18,
        border: `1px solid ${cardBorder}`,
        padding: '11px 13px',
        boxShadow: '0 2px 10px rgba(15, 23, 42, 0.03)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        position: 'relative',
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
        transition: 'all 0.25s ease',
        overflow: 'hidden',
      }}
    >
      {/* Hairline Crop Progress Bar at the top edge */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: '#f1f5f9',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${growthPercent ?? 0}%`,
            background: 'linear-gradient(90deg, #10b981, #059669)',
            transition: prefersReducedMotion ? 'none' : 'width 0.4s ease',
          }}
        />
      </div>

      {/* Toast Feedback */}
      {feedbackToast && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 12,
            right: 12,
            zIndex: 20,
            background: '#0f172a',
            color: '#ffffff',
            padding: '6px 10px',
            borderRadius: 8,
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}
        >
          <Check size={13} className="text-emerald-400 flex-shrink-0" />
          <span>{feedbackToast}</span>
        </div>
      )}

      {/* Header Row: Bot Title, Diurnal Phase (Icon + Short label) & Plant Badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              background: '#ecfdf5',
              color: '#059669',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Activity size={15} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap' }}>
            สรุปสถานะฟาร์ม
          </span>
          <div
            title={currentFacts.timeOfDayLabel}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '2px 6px',
              borderRadius: 9999,
              background: '#f8fafc',
              border: '1px solid #f1f5f9',
              fontSize: 10,
              fontWeight: 600,
              color: '#64748b',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {renderTimeIcon()}
            <span>
              {currentFacts.timeOfDay === 'morning'
                ? 'ช่วงเช้า'
                : currentFacts.timeOfDay === 'noon'
                  ? 'ช่วงเที่ยง'
                  : currentFacts.timeOfDay === 'afternoon'
                    ? 'ช่วงบ่าย'
                    : 'ช่วงค่ำ'}
            </span>
          </div>
        </div>

        {/* Right side: Plant Badge only (No cramped chevron!) */}
        <button
          type="button"
          onClick={onOpenSetupFarm}
          title="แตะเพื่อปรับชนิดพืชหรือวันที่เริ่มปลูก"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 10.5,
            color: '#475569',
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <span>{currentFacts.plantType}</span>
          <span style={{ color: '#059669', fontVariantNumeric: 'tabular-nums' }}>
            • D{currentFacts.plantDays}/{harvestCycleLabel}
          </span>
        </button>
      </div>

      {/* Speech Bubble: Briefing Message in FULL */}
      {isLoading ? (
        <div
          style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div
            style={{
              height: 10,
              background: '#e2e8f0',
              borderRadius: 4,
              width: '92%',
              animation: 'pulse 1.5s infinite ease-in-out',
            }}
          />
          <div
            style={{
              height: 10,
              background: '#e2e8f0',
              borderRadius: 4,
              width: '65%',
              animation: 'pulse 1.5s infinite ease-in-out',
            }}
          />
        </div>
      ) : (
        <div
          style={{
            background: cardBg,
            border: `1px solid ${cardBorder}`,
            borderRadius: 12,
            padding: '9px 12px',
            fontSize: 12,
            color: speechText,
            lineHeight: 1.52,
            letterSpacing: '-0.01em',
          }}
        >
          {briefingText}
        </div>
      )}

      {/* Bottom Row: Slim Harvest Countdown + Quick Actions */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: '#64748b' }}>
          <Clock size={11} className="text-emerald-600 flex-shrink-0" />
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            อีก {harvestRemainingLabel} วันพร้อมเก็บ ({growthPercentLabel})
          </span>
        </div>

        {/* Secondary Details Toggle */}
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          title={isExpanded ? 'ซ่อนรายละเอียด' : 'ดูรายละเอียดเพิ่มเติม / ติชม'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            background: isExpanded ? '#f1f5f9' : 'transparent',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            padding: '2px 8px',
            fontSize: 10.5,
            color: isExpanded ? '#0f172a' : '#64748b',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          <span>{isExpanded ? 'ซ่อน' : 'เพิ่มเติม'}</span>
          {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>

      {/* Expanded Only Section ("อันที่ไม่สำคัญไปอยู่ด้านใน"): Diurnal Full Description, Feedback Rating & Full Details */}
      {isExpanded && (
        <div
          style={{
            marginTop: 4,
            paddingTop: 8,
            borderTop: '1px dashed #e2e8f0',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {/* Full Diurnal Context */}
          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #f1f5f9',
              borderRadius: 8,
              padding: '6px 9px',
              fontSize: 10.5,
              color: '#475569',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {renderTimeIcon()}
            <span>
              <strong>สรีรวิทยาพืช:</strong> {currentFacts.timeOfDayLabel}
            </span>
          </div>

          {/* ThumbsUp / ThumbsDown Feedback Bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '1px 2px',
            }}
          >
            <span style={{ fontSize: 10.5, color: '#94a3b8' }}>
              ข้อมูลนี้เป็นประโยชน์ต่อคุณไหม?
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                disabled={feedbackGiven !== null || isLoading}
                onClick={handleThumbUp}
                style={{
                  background: feedbackGiven === 'up' ? '#ecfdf5' : 'transparent',
                  border: `1px solid ${feedbackGiven === 'up' ? '#a7f3d0' : '#e2e8f0'}`,
                  borderRadius: 6,
                  padding: '2px 10px',
                  minHeight: 44,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 10.5,
                  color: feedbackGiven === 'up' ? '#059669' : '#64748b',
                  cursor: feedbackGiven !== null || isLoading ? 'default' : 'pointer',
                  opacity: isLoading ? 0.6 : 1,
                }}
              >
                <ThumbsUp size={11} />
                <span>มีประโยชน์</span>
              </button>

              <button
                type="button"
                disabled={feedbackGiven !== null || isLoading}
                onClick={handleThumbDownClick}
                style={{
                  background: feedbackGiven === 'down' ? '#fef2f2' : 'transparent',
                  border: `1px solid ${feedbackGiven === 'down' ? '#fecaca' : '#e2e8f0'}`,
                  borderRadius: 6,
                  padding: '2px 10px',
                  minHeight: 44,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 10.5,
                  color: feedbackGiven === 'down' ? '#dc2626' : '#64748b',
                  cursor: feedbackGiven !== null || isLoading ? 'default' : 'pointer',
                  opacity: isLoading ? 0.6 : 1,
                }}
              >
                <ThumbsDown size={11} />
                <span>ไม่ตรง</span>
              </button>
            </div>
          </div>

          {/* Downvote Reason Selector */}
          {showDownvoteReasons && (
            <div
              style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                padding: '6px 8px',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              }}
            >
              <span style={{ fontSize: 10.5, fontWeight: 600, color: '#475569' }}>
                ส่วนไหนที่ไม่ตรง (บันทึกไว้ในเครื่องนี้):
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {downvoteReasons.map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    onClick={() => handleSelectDownvoteReason(reason)}
                    style={{
                      background: '#ffffff',
                      border: '1px solid #cbd5e1',
                      borderRadius: 5,
                      padding: '2px 10px',
                      minHeight: 44,
                      fontSize: 10,
                      color: '#334155',
                      cursor: 'pointer',
                    }}
                  >
                    {reason}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Growth Stage Progress Details */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10.5, color: '#64748b' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Clock size={12} className="text-emerald-600" />
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                อายุ {currentFacts.plantDays}/{harvestCycleLabel} วัน ({growthPercentLabel})
              </span>
            </div>
            <span style={{ color: '#059669', fontWeight: 600 }}>
              อีก {harvestRemainingLabel} วันพร้อมเก็บเกี่ยว
            </span>
          </div>

          {/* Detailed Diagnosis Button */}
          <button
            type="button"
            onClick={onOpenAIModal}
            style={{
              width: '100%',
              background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)',
              border: '1px solid #a7f3d0',
              borderRadius: 10,
              padding: '7px 12px',
              minHeight: 44,
              fontSize: 11,
              fontWeight: 600,
              color: '#059669',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              cursor: 'pointer',
            }}
          >
            <Sparkles size={12} />
            <span>ส่งข้อมูลให้ AI ภายนอกช่วยวิเคราะห์</span>
          </button>
        </div>
      )}
    </div>
  );
}
