// Shhh! 🥚
// ovum_white — custom one-off node type for the egg's spawned
// companion. Renders the bundled avatar + display name + credits
// without the entity-attribute sub-chip truncation. Pure presentation;
// reads everything from `data` (avatar URL, name, credits array, plus
// the play/pause + mute callbacks the egg passes in).
//
// Connects via a single target handle on the left so the silhouette
// edge can connect Apple's right output handle to this node's left
// input handle.

import { Handle, Position } from '@xyflow/react'

function PlayPauseIcon({ paused }) {
  if (paused) {
    return (
      <svg width={16} height={16} viewBox="0 0 24 24">
        <polygon points="6,4 20,12 6,20" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg width={16} height={16} viewBox="0 0 24 24">
      <rect x="6" y="4" width="4" height="16" fill="currentColor" />
      <rect x="14" y="4" width="4" height="16" fill="currentColor" />
    </svg>
  )
}

function MuteIcon({ muted }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24">
      <polygon
        points="4,9 9,9 14,5 14,19 9,15 4,15"
        fill="currentColor"
      />
      {muted ? (
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="17" y1="9" x2="22" y2="14" />
          <line x1="22" y1="9" x2="17" y2="14" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round">
          <path d="M 17 9 Q 19 12 17 15" />
          <path d="M 19 7 Q 22 12 19 17" />
        </g>
      )}
    </svg>
  )
}

const buttonStyle = {
  background: 'transparent',
  border: 'none',
  color: '#e4e4e7',
  cursor: 'pointer',
  padding: 4,
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}

export default function OvumWhiteCompanionNode({ data }) {
  const profileImage = data?.profileImage || ''
  const name = data?.name || ''
  const credits = Array.isArray(data?.credits) ? data.credits : []
  const colour = data?.colour || '#cccccc'
  const onPlayPause = data?.onPlayPause
  const onMute = data?.onMute
  const paused = !!data?.paused
  const muted = !!data?.muted

  return (
    <div
      className="ovum-white-companion-node"
      style={{
        background: '#1a1a1d',
        border: `1px solid ${colour}55`,
        borderRadius: 6,
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        color: '#e4e4e7',
        fontSize: 12,
        width: 360,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: colour, width: 8, height: 8, border: '1px solid #18181b' }}
      />

      {/* Avatar + name + media controls strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          background: '#222226',
          borderBottom: `1px solid ${colour}33`,
        }}
      >
        {profileImage ? (
          <img
            src={profileImage}
            alt=""
            style={{
              width: 44,
              height: 44,
              objectFit: 'cover',
              borderRadius: 4,
              border: `1.5px solid ${colour}`,
              flexShrink: 0,
            }}
          />
        ) : (
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 4,
              border: `1.5px solid ${colour}`,
              background: `${colour}22`,
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.2, flex: 1, minWidth: 0 }}>
          {name}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (typeof onPlayPause === 'function') onPlayPause()
          }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label={paused ? 'Play' : 'Pause'}
          title={paused ? 'Play' : 'Pause'}
          style={buttonStyle}
        >
          <PlayPauseIcon paused={paused} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (typeof onMute === 'function') onMute()
          }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label={muted ? 'Unmute' : 'Mute'}
          title={muted ? 'Unmute' : 'Mute'}
          style={buttonStyle}
        >
          <MuteIcon muted={muted} />
        </button>
      </div>

      {/* Credits — one row per entry, full text, line-wraps */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {credits.map((c, i) => (
          <div
            key={i}
            style={{ lineHeight: 1.45, wordBreak: 'break-word', whiteSpace: 'normal' }}
          >
            <span style={{ color: '#a1a1aa', fontWeight: 600 }}>{c?.label || ''}: </span>
            <span style={{ color: '#e4e4e7' }}>{c?.value || ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
