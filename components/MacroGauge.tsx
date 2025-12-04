import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { MACRO_ZONES } from '../constants';

interface MacroGaugeProps {
  value: number; // 0 to 100
}

export const MacroGauge: React.FC<MacroGaugeProps> = ({ value }) => {
  const data = [
    { name: 'Crisi', value: 33.3, color: MACRO_ZONES.CRISIS.color },
    { name: 'Neutro', value: 33.3, color: MACRO_ZONES.NEUTRAL.color },
    { name: 'Euforia', value: 33.3, color: MACRO_ZONES.EUPHORIA.color },
  ];

  // Calculate needle rotation
  // 180 degrees total. 0 value -> 180deg (left), 100 value -> 0deg (right)
  const rotation = 180 - (value / 100) * 180;

  const currentZone = value < 33 ? 'Crisi' : value < 66 ? 'Neutro' : 'Euforia';
  const currentColor = value < 33 ? MACRO_ZONES.CRISIS.color : value < 66 ? MACRO_ZONES.NEUTRAL.color : MACRO_ZONES.EUPHORIA.color;

  return (
    <div className="relative w-full h-48 flex flex-col items-center justify-center bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
      <h3 className="text-sm font-semibold text-gray-500 absolute top-4 left-4 flex items-center gap-1">
        <span className="material-symbols-outlined text-lg">speed</span>
        Indicatore Macro
      </h3>
      
      <div className="w-full h-full relative mt-2">
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
              paddingAngle={2}
              dataKey="value"
              stroke="none"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        
        {/* Needle */}
        <div 
          className="absolute bottom-0 left-1/2 w-1 h-24 bg-gray-800 origin-bottom transform -translate-x-1/2 transition-transform duration-500 ease-out z-10"
          style={{ transform: `translateX(-50%) rotate(-${rotation + 90}deg)` }} // Adjust for CSS rotation origin
        >
            <div className="w-3 h-3 bg-gray-900 rounded-full absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-1/2"></div>
        </div>
      </div>

      <div className="absolute bottom-2 flex flex-col items-center">
        <span className="text-3xl font-bold" style={{ color: currentColor }}>{Math.round(value)}</span>
        <span className="text-xs uppercase tracking-wider font-bold text-gray-400">{currentZone}</span>
      </div>
    </div>
  );
};