import React, { useState, useRef, useEffect } from 'react';
import { Plus, ChevronDown, X } from 'lucide-react';
import { FRESHNESS_LABEL } from './StatusBadge';

export type FarmFreshness = 'loading' | 'live' | 'stale' | 'offline' | 'no_data';

export interface FarmItem {
  id: string;
  name: string;
  plantType?: string;
  /** Fallback when `freshness` is not given (true = live or stale). */
  isOnline: boolean;
  /** 4-state freshness of the selected farm; preferred over isOnline when provided. */
  freshness?: FarmFreshness;
  hasCriticalAlert: boolean;
}

type FarmStatusTone = FarmFreshness | 'unselected';

/**
 * Only the selected farm is polled, so a non-selected farm's state is unknown
 * ("ไม่ได้เลือก") rather than "ออฟไลน์".
 */
function getFarmStatus(farm: FarmItem, isCurrent: boolean, isCurrentOnline: boolean): { tone: FarmStatusTone; label: string } {
  if (!isCurrent) return { tone: 'unselected', label: 'ไม่ได้เลือก' };
  const tone: FarmFreshness = farm.freshness ?? (isCurrentOnline ? 'live' : 'offline');
  return { tone, label: FRESHNESS_LABEL[tone] };
}

interface FarmCardCarouselProps {
  farms: FarmItem[];
  selectedFarmId: string | null;
  currentPlantDays: number | null;
  currentPlantType: string;
  isCurrentOnline: boolean;
  onSelectFarm: (farmId: string) => void;
  onAddFarm: () => void;
  prefersReducedMotion?: boolean;
}

type DeckItem =
  | { type: 'farm'; data: FarmItem }
  | { type: 'add' };

export default function FarmCardCarousel({
  farms,
  selectedFarmId,
  currentPlantDays,
  currentPlantType,
  isCurrentOnline,
  onSelectFarm,
  onAddFarm,
  prefersReducedMotion = false,
}: FarmCardCarouselProps) {
  // Build deck items: farms (1 to N) + last card "เพิ่มฟาร์มใหม่"
  const deck: DeckItem[] = [
    ...farms.map((f): DeckItem => ({ type: 'farm', data: f })),
    { type: 'add' },
  ];

  const totalCards = deck.length;

  const [topIndex, setTopIndex] = useState(() => {
    const idx = farms.findIndex((f) => f.id === selectedFarmId);
    return idx >= 0 ? idx : 0;
  });

  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [animStep, setAnimStep] = useState<'none' | 'step1' | 'step2'>('none');
  const [swipeDir, setSwipeDir] = useState<number>(1);
  const [isBottomSheetOpen, setIsBottomSheetOpen] = useState(false);

  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const isHorizontalSwipeRef = useRef<boolean | null>(null);
  // true once the current press turned into a horizontal swipe: the click that ends it is not a tap
  const didSwipeRef = useRef(false);

  // Sync topIndex only when the selected farm (or the list of farms) really changes.
  // `farms` is a new array on every parent render (data polls every few seconds), so depending on
  // its identity snapped the deck back to the selected farm, e.g. away from "เพิ่มฟาร์มใหม่".
  const farmIdsKey = farms.map((f) => f.id).join('|');
  useEffect(() => {
    const idx = farms.findIndex((f) => f.id === selectedFarmId);
    if (idx >= 0 && !isAnimating) {
      setTopIndex(idx);
    } else if (topIndex >= totalCards) {
      setTopIndex(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFarmId, farmIdsKey]);

  const triggerHaptic = () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(25);
      }
    } catch (e) {}
  };

  const handlePointerDown = (clientX: number, clientY: number) => {
    if (isAnimating) return;
    startXRef.current = clientX;
    startYRef.current = clientY;
    isHorizontalSwipeRef.current = null;
    didSwipeRef.current = false;
    setIsDragging(true);
  };

  const handlePointerMove = (clientX: number, clientY: number) => {
    if (!isDragging || isAnimating) return;
    const diffX = clientX - startXRef.current;
    const diffY = clientY - startYRef.current;

    if (isHorizontalSwipeRef.current === null) {
      if (Math.abs(diffX) > 8 || Math.abs(diffY) > 8) {
        isHorizontalSwipeRef.current = Math.abs(diffX) > Math.abs(diffY);
        if (isHorizontalSwipeRef.current) didSwipeRef.current = true;
      }
    }

    if (isHorizontalSwipeRef.current) {
      setDragOffset(diffX);
    }
  };

  const handlePointerUp = () => {
    if (!isDragging || isAnimating) return;
    setIsDragging(false);

    if (isHorizontalSwipeRef.current && Math.abs(dragOffset) >= 80) {
      const dir = dragOffset > 0 ? 1 : -1; // direction the card flies out
      executeCardSwap(dir, dragOffset < 0 ? 1 : -1);
    } else {
      setDragOffset(0);
    }
    isHorizontalSwipeRef.current = null;
  };

  const selectCardAt = (nextIdx: number) => {
    setTopIndex(nextIdx);
    triggerHaptic();
    const nextItem = deck[nextIdx];
    if (nextItem.type === 'farm') {
      onSelectFarm(nextItem.data.id);
    }
  };

  // step +1 = next card (swipe left), -1 = previous card (swipe right)
  const executeCardSwap = (dir: number, step: 1 | -1 = 1) => {
    if (step === -1) {
      // Going back: the previous card is at the back of the stack, so bring it to the front
      // directly; the at-rest transition slides the stack into place.
      setDragOffset(0);
      selectCardAt((topIndex - 1 + totalCards) % totalCards);
      return;
    }
    if (prefersReducedMotion) {
      // Reduced motion: instant crossfade
      const nextIdx = (topIndex + 1) % totalCards;
      setTopIndex(nextIdx);
      setDragOffset(0);
      triggerHaptic();
      const nextItem = deck[nextIdx];
      if (nextItem.type === 'farm') {
        onSelectFarm(nextItem.data.id);
      }
      return;
    }

    setIsAnimating(true);
    setSwipeDir(dir);
    setAnimStep('step1');

    // Step 1: Top card slides out (70px out, 24px down, 5deg tilt) in 160ms
    setTimeout(() => {
      // Step 2: z-index lowers behind stack; tucks into back position (28px down, scale 88%) in 320ms
      setAnimStep('step2');

      setTimeout(() => {
        // Complete swap: update topIndex and notify farm switch
        const nextIdx = (topIndex + 1) % totalCards;
        setTopIndex(nextIdx);
        setAnimStep('none');
        setIsAnimating(false);
        setDragOffset(0);
        triggerHaptic();

        const nextItem = deck[nextIdx];
        if (nextItem.type === 'farm') {
          onSelectFarm(nextItem.data.id);
        }
      }, 320);
    }, 160);
  };

  return (
    <div style={{ position: 'relative', width: '100%', userSelect: 'none' }}>
      {/* ── Card Stack Viewport (Fixed height to prevent overlapping water quality section) ── */}
      <div
        onTouchStart={(e) => handlePointerDown(e.touches[0].clientX, e.touches[0].clientY)}
        onTouchMove={(e) => handlePointerMove(e.touches[0].clientX, e.touches[0].clientY)}
        onTouchEnd={handlePointerUp}
        onMouseDown={(e) => handlePointerDown(e.clientX, e.clientY)}
        onMouseMove={(e) => handlePointerMove(e.clientX, e.clientY)}
        onMouseUp={handlePointerUp}
        onMouseLeave={handlePointerUp}
        style={{
          position: 'relative',
          width: '100%',
          height: 172,
          touchAction: 'pan-y',
          overflow: 'visible',
          cursor: isDragging ? 'grabbing' : 'grab',
        }}
      >
        {deck.map((item, idx) => {
          // Relative position in deck: 0 = top, 1 = second, 2 = third, etc.
          const relPos = (idx - topIndex + totalCards) % totalCards;

          // Render only the top 3 cards (or 4 during animated tuck-under)
          if (relPos > 3 && !isAnimating) return null;

          let transform = '';
          let opacity = 1;
          let filter = 'brightness(1)';
          let zIndex = 10 - relPos;
          let transition = 'none';

          const easing = 'cubic-bezier(.3, .8, .3, 1)';

          if (isAnimating) {
            if (relPos === 0) {
              if (animStep === 'step1') {
                // Step 1: Slide out 70px in swipe direction, down 24px, tilt 5 deg
                transform = `translate3d(${swipeDir * 70}px, 24px, 0px) rotate(${swipeDir * 5}deg) scale(1)`;
                opacity = 1;
                filter = 'brightness(1)';
                zIndex = 10;
                transition = `transform 160ms ${easing}`;
              } else if (animStep === 'step2') {
                // Step 2: Under stack, tuck into back position
                const targetY = totalCards === 2 ? 14 : 28;
                const targetScale = totalCards === 2 ? 0.94 : 0.88;
                transform = `translate3d(0px, ${targetY}px, 0px) rotate(0deg) scale(${targetScale})`;
                opacity = totalCards === 2 ? 0.88 : 0.76;
                filter = totalCards === 2 ? 'brightness(0.92)' : 'brightness(0.85)';
                zIndex = 1; // Under the stack
                transition = `transform 320ms ${easing}, opacity 320ms ${easing}, filter 320ms ${easing}`;
              }
            } else if (relPos === 1) {
              // Second card rises to become top card
              transform = 'translate3d(0px, 0px, 0px) scale(1)';
              opacity = 1;
              filter = 'brightness(1)';
              zIndex = 9;
              transition = `all 480ms ${easing}`;
            } else if (relPos === 2) {
              // Third card rises to position 1
              transform = 'translate3d(0px, 14px, 0px) scale(0.94)';
              opacity = 0.88;
              filter = 'brightness(0.92)';
              zIndex = 8;
              transition = `all 480ms ${easing}`;
            } else if (relPos === 3) {
              // Fourth card rises to position 2
              transform = 'translate3d(0px, 28px, 0px) scale(0.88)';
              opacity = 0.76;
              filter = 'brightness(0.85)';
              zIndex = 7;
              transition = `all 480ms ${easing}`;
            }
          } else if (isDragging) {
            const ratio = Math.min(1, Math.abs(dragOffset) / 80);
            if (relPos === 0) {
              const rotation = Math.max(-8, Math.min(8, (dragOffset / 120) * 8));
              transform = `translate3d(${dragOffset}px, 0px, 0px) rotate(${rotation}deg) scale(1)`;
              opacity = 1;
              filter = 'brightness(1)';
              zIndex = 10;
              transition = 'none';
            } else if (relPos === 1) {
              const y = 14 * (1 - ratio);
              const scale = 0.94 + 0.06 * ratio;
              const op = 0.88 + 0.12 * ratio;
              const br = 0.92 + 0.08 * ratio;
              transform = `translate3d(0px, ${y}px, 0px) scale(${scale})`;
              opacity = op;
              filter = `brightness(${br})`;
              zIndex = 9;
              transition = 'none';
            } else if (relPos === 2 && totalCards >= 3) {
              const y = 28 - 14 * ratio;
              const scale = 0.88 + 0.06 * ratio;
              const op = 0.76 + 0.12 * ratio;
              const br = 0.85 + 0.07 * ratio;
              transform = `translate3d(0px, ${y}px, 0px) scale(${scale})`;
              opacity = op;
              filter = `brightness(${br})`;
              zIndex = 8;
              transition = 'none';
            } else {
              opacity = 0;
              zIndex = 0;
            }
          } else {
            // At rest (static stacked layout)
            if (relPos === 0) {
              transform = 'translate3d(0px, 0px, 0px) scale(1)';
              opacity = 1;
              filter = 'brightness(1)';
              zIndex = 10;
              transition = prefersReducedMotion ? 'none' : `transform 250ms ${easing}`;
            } else if (relPos === 1) {
              transform = 'translate3d(0px, 14px, 0px) scale(0.94)';
              opacity = 0.88;
              filter = 'brightness(0.92)';
              zIndex = 9;
              transition = prefersReducedMotion ? 'none' : `all 250ms ${easing}`;
            } else if (relPos === 2 && totalCards >= 3) {
              transform = 'translate3d(0px, 28px, 0px) scale(0.88)';
              opacity = 0.76;
              filter = 'brightness(0.85)';
              zIndex = 8;
              transition = prefersReducedMotion ? 'none' : `all 250ms ${easing}`;
            } else {
              opacity = 0;
              zIndex = 0;
              transition = 'none';
            }
          }

          if (item.type === 'add') {
            return (
              <div
                key="add-farm-card"
                onClick={
                  relPos === 0
                    ? () => {
                        if (didSwipeRef.current) return; // the click that ends a swipe is not a tap
                        onAddFarm();
                      }
                    : undefined
                }
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: 140,
                  background: 'linear-gradient(135deg, #059669 0%, #047857 100%)',
                  borderRadius: 20,
                  padding: '20px',
                  color: '#ffffff',
                  boxShadow: '0 8px 24px rgba(5, 150, 105, 0.22)',
                  overflow: 'hidden',
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  cursor: relPos === 0 ? 'pointer' : 'default',
                  border: '1.5px dashed rgba(255, 255, 255, 0.45)',
                  transformOrigin: 'top center',
                  transform,
                  opacity,
                  filter,
                  zIndex,
                  transition,
                  willChange: 'transform, opacity',
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: 'rgba(255, 255, 255, 0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 8,
                  }}
                >
                  <Plus size={24} strokeWidth={2.2} color="#ffffff" />
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>
                  เพิ่มฟาร์มใหม่
                </div>
                <div style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.85)', marginTop: 2 }}>
                  เชื่อมต่ออุปกรณ์ใหม่
                </div>
              </div>
            );
          }

          const farm = item.data;
          const isCurrent = farm.id === selectedFarmId;
          const status = getFarmStatus(farm, isCurrent, isCurrentOnline);
          const online = status.tone === 'live' || status.tone === 'stale';
          const plantTitle = isCurrent
            ? currentPlantType || farm.plantType || 'พืชไฮโดรโปนิกส์'
            : farm.plantType || 'พืชไฮโดรโปนิกส์';
          const cycleText =
            isCurrent && currentPlantDays
              ? `ระยะการเติบโตวันที่ ${currentPlantDays}`
              : 'รอบการปลูกปัจจุบัน';

          return (
            <div
              key={farm.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: 140,
                background: 'linear-gradient(135deg, #064e3b 0%, #065f46 60%, #047857 100%)',
                borderRadius: 22,
                padding: '18px 20px',
                color: '#ffffff',
                border: '1px solid rgba(255, 255, 255, 0.18)',
                boxShadow: '0 10px 25px -5px rgba(6, 78, 59, 0.25), 0 4px 10px -2px rgba(6, 78, 59, 0.15)',
                overflow: 'hidden',
                boxSizing: 'border-box',
                transformOrigin: 'top center',
                transform,
                opacity,
                filter,
                zIndex,
                transition,
                willChange: 'transform, opacity',
              }}
            >
              {/* Subtle geometric circles */}
              <div
                style={{
                  position: 'absolute',
                  top: -30,
                  right: -30,
                  width: 140,
                  height: 140,
                  borderRadius: '50%',
                  background: 'rgba(255, 255, 255, 0.08)',
                  pointerEvents: 'none',
                }}
              />

              {/* Top Row: Clickable Farm Name + Status Badge */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (didSwipeRef.current) return;
                    setIsBottomSheetOpen(true);
                  }}
                  style={{
                    background: 'rgba(255, 255, 255, 0.15)',
                    border: 'none',
                    borderRadius: 14,
                    padding: '4px 10px 4px 12px',
                    color: '#ffffff',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    backdropFilter: 'blur(4px)',
                  }}
                >
                  <span>{farm.name || 'ฟาร์มไฮโดรโปนิกส์'}</span>
                  <ChevronDown size={14} strokeWidth={2} />
                </button>

                {/* Freshness Indicator (ออนไลน์ / ข้อมูลเริ่มเก่า / ออฟไลน์ / ไม่ได้เลือก) */}
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 10px',
                    borderRadius: 20,
                    background: online ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)',
                    backdropFilter: 'blur(4px)',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: status.tone === 'live' ? '#34d399' : status.tone === 'stale' ? '#fbbf24' : '#94a3b8',
                      boxShadow: status.tone === 'live' ? '0 0 8px #34d399' : 'none',
                      animation: status.tone === 'live' && !prefersReducedMotion ? 'dotPulse 1.8s infinite' : 'none',
                    }}
                  />
                  <span>{status.label}</span>
                </div>
              </div>

              {/* Plant details */}
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <div>
                  <h2 style={{ fontSize: 24, fontWeight: 600, margin: 0, letterSpacing: '-0.02em' }}>
                    {plantTitle}
                  </h2>
                  <p style={{ fontSize: 13, color: 'rgba(255, 255, 255, 0.85)', margin: '4px 0 0' }}>
                    {cycleText}
                  </p>
                </div>
              </div>

              {/* Critical Alert Red Dot on exposed bottom right strip */}
              {farm.hasCriticalAlert && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 6,
                    right: 14,
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: '#dc2626',
                    boxShadow: '0 0 4px rgba(220, 38, 38, 0.8)',
                  }}
                  title="มีการแจ้งเตือนระดับวิกฤต"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* ── Page Dots ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          marginTop: 12,
        }}
      >
        {deck.map((item, idx) => {
          const isTop = idx === topIndex;

          if (item.type === 'add') {
            return (
              <div
                key="dot-add"
                onClick={() => {
                  if (isAnimating) return;
                  setTopIndex(idx);
                  triggerHaptic();
                }}
                style={{
                  width: isTop ? 22 : 6,
                  height: 6,
                  borderRadius: 3,
                  background: isTop ? '#059669' : '#cbd5e1',
                  transition: prefersReducedMotion ? 'none' : 'all 0.25s cubic-bezier(.3, .8, .3, 1)',
                  cursor: 'pointer',
                }}
              />
            );
          }

          const isCritical = item.data.hasCriticalAlert;

          return (
            <div
              key={item.data.id}
              onClick={() => {
                if (isAnimating) return;
                setTopIndex(idx);
                triggerHaptic();
                onSelectFarm(item.data.id);
              }}
              style={{
                width: isTop ? 22 : 6,
                height: 6,
                borderRadius: 3,
                background: isTop ? '#059669' : isCritical ? '#dc2626' : '#cbd5e1',
                transition: prefersReducedMotion ? 'none' : 'all 0.25s cubic-bezier(.3, .8, .3, 1)',
                cursor: 'pointer',
              }}
            />
          );
        })}
      </div>

      {/* ── Bottom Sheet (Farm Selector Modal) ── */}
      {isBottomSheetOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}
        >
          {/* Backdrop */}
          <div
            onClick={() => setIsBottomSheetOpen(false)}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(15, 23, 42, 0.45)',
              backdropFilter: 'blur(3px)',
            }}
          />

          {/* Sheet Surface */}
          <div
            style={{
              position: 'relative',
              background: '#ffffff',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: '16px 20px 32px',
              boxShadow: '0 -8px 30px rgba(0, 0, 0, 0.15)',
              zIndex: 1001,
              maxHeight: '80vh',
              overflowY: 'auto',
            }}
          >
            {/* Grab handle */}
            <div
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                background: '#cbd5e1',
                margin: '0 auto 14px',
              }}
            />

            {/* Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 14,
                paddingBottom: 10,
                borderBottom: '1px solid #f1f5f9',
              }}
            >
              <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', margin: 0 }}>
                เลือกฟาร์ม
              </h3>
              <button
                type="button"
                onClick={() => setIsBottomSheetOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 4,
                  cursor: 'pointer',
                  color: '#64748b',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <X size={18} strokeWidth={2} />
              </button>
            </div>

            {/* Farm List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {farms.map((farm, idx) => {
                const isSelected = farm.id === selectedFarmId;
                const rowStatus = getFarmStatus(farm, isSelected, isCurrentOnline);
                const rowTone =
                  rowStatus.tone === 'live'
                    ? { bg: '#dcfce7', color: '#15803d' }
                    : rowStatus.tone === 'stale'
                      ? { bg: '#fef3c7', color: '#b45309' }
                      : { bg: '#f1f5f9', color: '#64748b' };

                return (
                  <div
                    key={farm.id}
                    onClick={() => {
                      setTopIndex(idx);
                      triggerHaptic();
                      onSelectFarm(farm.id);
                      setIsBottomSheetOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      borderRadius: 14,
                      background: isSelected ? '#ecfdf5' : '#f8fafc',
                      border: isSelected ? '1px solid #059669' : '1px solid #e2e8f0',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: isSelected ? '#059669' : '#cbd5e1',
                        }}
                      />
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>
                          {farm.name}
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                          {farm.plantType || 'พืชไฮโดรโปนิกส์'}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {/* Critical Alert Dot */}
                      {farm.hasCriticalAlert && (
                        <div
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: '#dc2626',
                          }}
                          title="มีการแจ้งเตือนระดับวิกฤต"
                        />
                      )}

                      {/* Status Badge */}
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 9999,
                          background: rowTone.bg,
                          color: rowTone.color,
                        }}
                      >
                        {rowStatus.label}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Add Farm Row at end */}
              <div
                onClick={() => {
                  setIsBottomSheetOpen(false);
                  onAddFarm();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 14,
                  background: '#ffffff',
                  border: '1.5px dashed #cbd5e1',
                  cursor: 'pointer',
                  marginTop: 6,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: '#ecfdf5',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Plus size={16} strokeWidth={2.5} color="#059669" />
                </div>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#059669' }}>
                  เพิ่มฟาร์มใหม่
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
