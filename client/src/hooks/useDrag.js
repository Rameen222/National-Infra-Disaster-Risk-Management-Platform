import { useState, useCallback, useEffect, useRef } from 'react';

export default function useDrag(initialX, initialY) {
  const [pos, setPos] = useState({ x: initialX ?? 0, y: initialY ?? 0 });
  const dragging = useRef(false);
  const moved = useRef(false);
  const offset = useRef({ x: 0, y: 0 });

  const onMouseDown = useCallback((e) => {
    // Don't drag when clicking buttons/inputs
    if (e.target.closest('button, input, select, textarea')) return;
    dragging.current = true;
    moved.current = false;
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragging.current) return;
      moved.current = true;
      setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y });
    };
    const onMouseUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // didMoveRef.current is true if the most recent mousedown→up included movement
  return { pos, setPos, onMouseDown, didMoveRef: moved };
}
