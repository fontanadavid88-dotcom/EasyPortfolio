import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { MACRO_ZONES, CARD_BG } from '../constants';

interface MacroGaugeProps {
  value: number; // 0 to 100
}

export const MacroGauge: React.FC<MacroGaugeProps> = ({ value }) => {
  const currentZone = useMemo(() => {
    if (value < MACRO_ZONES.CRISIS.max) return MACRO_ZONES.CRISIS;
    if (value < MACRO_ZONES.NEUTRAL.max) return MACRO_ZONES.NEUTRAL;
    return MACRO_ZONES.EUPHORIA;
  }, [value]);

  const data = [
    { name: 'Crisi', value: 33.3, color: MACRO_ZONES.CRISIS.color },
    { name: 'Neutro', value: 33.3, color: MACRO_ZONES.NEUTRAL.color },
    { name: 'Euforia', value: 33.3, color: MACRO_ZONES.EUPHORIA.color },
  ];

  // Calculate needle rotation
  // 0 value -> -90deg (left), 100 value -> 90deg (right)
  const rotation = (value / 100) * 180 - 90;

  return (
    <div className="w-full flex flex-col items-center bg-transparent p-0">
      <div className="w-full h-40 relative">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="100%"
              startAngle={180}
              endAngle={0}
              innerRadius={60}
              outerRadius={90}
              paddingAngle={4}
              dataKey="value"
              stroke="none"
              cornerRadius={4}
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} stroke={CARD_BG} strokeWidth={2} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* Needle */}
        <div
          className="absolute bottom-0 left-1/2 w-1.5 h-24 bg-slate-800 origin-bottom transform -translate-x-1/2 transition-transform duration-700 ease-out z-10 shadow-md rounded-t-full"
          style={{ transform: `translateX(-50%) rotate(${rotation}deg)` }}
        >
          <div className="w-3 h-3 bg-slate-800 rounded-full absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-1/2 shadow-lg border-2 border-white"></div>
        </div>
      </div>

      <div className="mt-3 flex flex-col items-center">
        <span
          className="text-4xl font-bold drop-shadow-md transition-colors duration-500"
          style={{ color: currentZone.color }}
        >
          {Math.round(value)}
        </span>
        <span
          className="text-xs uppercase tracking-widest font-bold mt-1"
          style={{ color: currentZone.color }}
        >
          {currentZone.label.toUpperCase()}
        </span>
      </div>
    </div>
  );
};
