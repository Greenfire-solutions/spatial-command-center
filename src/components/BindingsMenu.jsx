/*
 * The bindings menu.
 *
 * Which button means "enter" is muscle memory, so this exists to be changed.
 * The defaults are one opinion; everything here is editable and persisted per
 * browser, and reserved inputs are shown rather than hidden so a choice that
 * would cost you grabbing a screen is visible before it is made.
 */

import React, { useEffect, useState } from 'react';

import {
  ACTIONS,
  INPUTS,
  conflictsFor,
  reservedFor,
  getBindings,
  onBindingsChange,
  resetBindings,
  setBinding
} from '../xr/bindings.js';

const HANDS = [
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' }
];

const inputsForHand = (hand) => INPUTS.filter((input) => input.hands.includes(hand));

export const BindingsMenu = ({ open, onClose }) => {
  const [bindings, setBindings] = useState(getBindings);

  useEffect(() => onBindingsChange(setBindings), []);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 pointer-events-auto">
      <div className="glass-panel rounded-2xl w-[min(94vw,560px)] max-h-[80vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="text-white font-semibold text-sm">Controller bindings</div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-lg leading-none px-2"
          >
            ×
          </button>
        </div>
        <p className="text-[11px] text-gray-500 mb-3">
          Text actions apply only while a screen has keyboard focus, so the same
          buttons stay free while you are moving around.
        </p>
        <p className="text-[11px] text-gray-500 mb-4">
          Each hand is independent. Only the grips are genuinely both-handed:
          pressed together they resize a screen. Both triggers do the same job,
          so freeing one costs only clicking with that hand.
        </p>

        {ACTIONS.map((action) => {
          const binding = bindings[action.id] || action.default;
          const conflicts = conflictsFor(action.id);
          const reserved = reservedFor(binding.hand, binding.input);
          return (
            <div key={action.id} className="py-2.5 border-t border-white/10 first:border-t-0">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] text-gray-100">{action.label}</div>
                  <div className="text-[11px] text-gray-500">{action.describe}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <select
                    value={binding.hand}
                    onChange={(event) => setBinding(action.id, { ...binding, hand: event.target.value })}
                    className="bg-white/5 text-gray-200 text-[12px] rounded-lg px-2 py-1.5 outline-none"
                  >
                    {HANDS.map((hand) => (
                      <option key={hand.id} value={hand.id} className="bg-[#121a27]">{hand.label}</option>
                    ))}
                  </select>
                  <select
                    value={binding.input}
                    onChange={(event) => setBinding(action.id, { ...binding, input: event.target.value || null })}
                    className="bg-white/5 text-gray-200 text-[12px] rounded-lg px-2 py-1.5 outline-none"
                  >
                    {inputsForHand(binding.hand).map((input) => {
                      const inUse = reservedFor(binding.hand, input.id);
                      return (
                        <option key={String(input.id)} value={input.id || ''} className="bg-[#121a27]">
                          {input.label}{inUse ? ' (in use)' : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              {reserved ? (
                <div className={`mt-1.5 text-[11px] ${reserved.severity === 'hard' ? 'text-red-300' : 'text-amber-300'}`}>
                  On the {binding.hand} hand this costs {reserved.cost}.
                </div>
              ) : null}
              {conflicts.length ? (
                <div className="mt-1.5 text-[11px] text-amber-300">
                  Same button as {conflicts.map((entry) => entry.label).join(', ')}.
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/10">
          <button
            type="button"
            onClick={resetBindings}
            className="text-[12px] text-gray-400 hover:text-white"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-semibold"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default BindingsMenu;
