import { useMemo } from 'react'
import { Position } from '@xyflow/react'
import PortHandle from '../canvas/PortHandle'
import { usePovColor, getPovDerived, useAccentColor } from '../../utils/povConstants'
import { useMultiSelectActive } from '../../hooks/useMultiSelectActive'

export default function PovOriginNode({ id, selected }) {
  const povColor = usePovColor()
  const accentColor = useAccentColor()
  const multiSelectActive = useMultiSelectActive()
  const { bright, glow } = getPovDerived(povColor)
  // Phase 4.1g #3 — stable handle-style identity, memoized on the POV colour.
  const handleStyle = useMemo(() => ({
    width: 8, height: 8, background: povColor, border: '2px solid #18181b', right: -5,
  }), [povColor])

  return (
    <div
      data-help-region="pov-origin-node:badge"
      className="relative flex items-center justify-center"
      style={{
        width: 48,
        height: 24,
        backgroundColor: '#27272a',
        border: `2px solid ${selected ? bright : povColor}`,
        borderRadius: 5,
        boxShadow: selected ? `0 0 8px ${glow}` : undefined,
        // Phase 1.11 Track I — dashed accent-colour selection outline
        // only in multi-select. Single-click selection is already
        // indicated by the POV glow + border brightening above, so the
        // dashed outline would be redundant.
        outline: (selected && multiSelectActive) ? `2px dashed ${accentColor}` : undefined,
        outlineOffset: (selected && multiSelectActive) ? 3 : undefined,
      }}
    >
      <span
        className="text-[11px] font-bold select-none"
        style={{ color: povColor }}
      >POV</span>

      {/* Single output port — right side */}
      <PortHandle
        nodeId={id}
        nodeType="povOriginNode"
        type="source"
        position={Position.Right}
        id="pov-out"
        style={handleStyle}
      />
    </div>
  )
}
