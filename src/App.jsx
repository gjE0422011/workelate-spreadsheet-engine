import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'

const TOTAL_ROWS = 50
const TOTAL_COLS = 50

// Shift relative formula references while preserving $-anchored references.
function shiftFillFormula(raw, rowOffset, colOffset) {
  return raw.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (full, colLock, letters, rowLock, digits) => {
    let col = 0
    for (const char of letters) col = col * 26 + char.charCodeAt(0) - 64
    col--
    const row = Number(digits) - 1
    const newCol = colLock ? col : col + colOffset
    const newRow = rowLock ? row : row + rowOffset
    if (newCol < 0 || newRow < 0) return '#REF!'
    let n = newCol + 1
    let label = ''
    while (n) { n--; label = String.fromCharCode(65 + n % 26) + label; n = Math.floor(n / 26) }
    return `${colLock}${label}${rowLock}${newRow + 1}`
  })
}

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
function extendFillValue(values, index) {
  const seeds = values.map(v => String(v ?? ''))
  const first = seeds[0]
  if (!first) return seeds[((index % seeds.length) + seeds.length) % seeds.length]
  if (seeds.every(v => v.trim() && Number.isFinite(Number(v)))) {
    const step = seeds.length > 1 ? Number(seeds[1]) - Number(first) : 0
    return String(Number(first) + step * index)
  }
  const parseDate = s => {
    const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!match) return null
    const t = Date.UTC(+match[1], +match[2] - 1, +match[3])
    return new Date(t).toISOString().slice(0,10) === s ? t : null
  }
  const dates = seeds.map(parseDate)
  if (dates.every(d => d !== null)) {
    const step = seeds.length > 1 ? dates[1] - dates[0] : 86400000
    return new Date(dates[0] + step * index).toISOString().slice(0,10)
  }
  const suffixes = seeds.map(v => v.match(/^(.*?)(\d+)$/))
  if (suffixes.every(Boolean) && suffixes.every(v => v[1] === suffixes[0][1])) {
    const step = seeds.length > 1 ? Number(suffixes[1][2]) - Number(suffixes[0][2]) : 1
    const n = Number(suffixes[0][2]) + step * index
    return suffixes[0][1] + String(n).padStart(suffixes[0][2].length,'0')
  }
  for (const words of [WEEKDAYS, MONTHS]) {
    const positions = seeds.map(v => words.findIndex(w => w.toLowerCase() === v.toLowerCase() || w.slice(0,3).toLowerCase() === v.toLowerCase()))
    if (positions.every(p => p >= 0)) {
      const step = seeds.length > 1 ? (positions[1] - positions[0] + words.length) % words.length : 1
      const word = words[((positions[0] + step * index) % words.length + words.length) % words.length]
      const shortened = word.slice(0,first.length)
      return first === first.toUpperCase() ? shortened.toUpperCase() : first === first.toLowerCase() ? shortened.toLowerCase() : shortened
    }
  }
  return seeds[((index % seeds.length) + seeds.length) % seeds.length]
}

export default function App() {
  // Engine instance is created once and reused across renders
  // Note: The engine maintains its own internal state, so React state is only used for UI updates
  const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [, setVersion] = useState(0)
  const [selectedCell, setSelectedCell] = useState(null)
  const [selectionEnd, setSelectionEnd] = useState(null)
  const isDraggingRef = useRef(false)
  const fillDragRef = useRef(null)
  const [fillTarget, setFillTarget] = useState(null)
  const [editingCell, setEditingCell] = useState(null)
  const [editValue, setEditValue] = useState('')
  // Cell styles are stored separately from engine data
  // Format: { "row,col": { bold: bool, italic: bool, ... } }
  const [cellStyles, setCellStyles] = useState({})
  const cellInputRef = useRef(null)

  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  // ────── Cell style helpers ──────

  const getCellStyle = useCallback((row, col) => {
    const key = `${row},${col}`
    return cellStyles[key] || {
      bold: false, italic: false, underline: false,
      bg: 'white', color: '#202124', align: 'left', fontSize: 13
    }
  }, [cellStyles])

  const updateCellStyle = useCallback((row, col, updates) => {
    const key = `${row},${col}`
    setCellStyles(prev => ({
      ...prev,
      [key]: { ...getCellStyle(row, col), ...updates }
    }))
  }, [getCellStyle])

  // ────── Cell editing ──────

  const startEditing = useCallback((row, col) => {
    setSelectedCell({ r: row, c: col })
    setEditingCell({ r: row, c: col })
    const cellData = engine.getCell(row, col)
    setEditValue(cellData.raw)
    setTimeout(() => cellInputRef.current?.focus(), 0)
  }, [engine])

  const commitEdit = useCallback((row, col) => {
    // Only commit if the value actually changed to avoid unnecessary recalculations
    const currentCell = engine.getCell(row, col)
    if (currentCell.raw !== editValue) {
      engine.setCell(row, col, editValue)
      forceRerender()
    }
    setEditingCell(null)
  }, [engine, editValue, forceRerender])

  const handleCellClick = useCallback((row, col, shiftKey = false) => {
    if (editingCell) commitEdit(editingCell.r, editingCell.c)

    if (shiftKey && selectedCell) {
      setSelectionEnd({ r: row, c: col })
    } else {
      setSelectedCell({ r: row, c: col })
      setSelectionEnd({ r: row, c: col })
    }
    setEditingCell(null)
  }, [editingCell, commitEdit, selectedCell])

  const handleCellDoubleClick = useCallback((row, col) => {
    setSelectionEnd({ r: row, c: col })
    startEditing(row, col)
  }, [startEditing])

  const handleCellMouseEnter = useCallback((row, col) => {
    if (fillDragRef.current) {
      fillDragRef.current.target = { r: row, c: col }
      setFillTarget({ r: row, c: col })
    } else if (isDraggingRef.current) setSelectionEnd({ r: row, c: col })
  }, [])

  const handleCellMouseUp = useCallback(() => {
    isDraggingRef.current = false
  }, [])

  // ────── Keyboard navigation ──────

  const handleKeyDown = useCallback((event, row, col) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.min(row + 1, engine.rows - 1), col)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(row, Math.min(col + 1, engine.cols - 1))
    } else if (event.key === 'Escape') {
      setEditValue(engine.getCell(row, col).raw)
      setEditingCell(null)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.min(row + 1, engine.rows - 1), col)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.max(row - 1, 0), col)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      commitEdit(row, col)
      if (col > 0) {
        startEditing(row, col - 1)
      } else if (row > 0) {
        startEditing(row - 1, engine.cols - 1)
      }
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(row, Math.min(col + 1, engine.cols - 1))
    }
  }, [engine, commitEdit, startEditing])

  // ────── Formula bar handlers ──────

  const handleFormulaBarKeyDown = useCallback((event) => {
    if (!editingCell) return
    handleKeyDown(event, editingCell.r, editingCell.c)
  }, [editingCell, handleKeyDown])

  const handleFormulaBarFocus = useCallback(() => {
    if (selectedCell && !editingCell) {
      setEditingCell(selectedCell)
      setEditValue(engine.getCell(selectedCell.r, selectedCell.c).raw)
    }
  }, [selectedCell, editingCell, engine])

  const handleFormulaBarChange = useCallback((value) => {
    if (!editingCell && selectedCell) setEditingCell(selectedCell)
    setEditValue(value)
  }, [editingCell, selectedCell])

  // ────── Undo / Redo ──────

  const handleUndo = useCallback(() => { if (engine.undo()) forceRerender() }, [engine, forceRerender])
  const handleRedo = useCallback(() => { if (engine.redo()) forceRerender() }, [engine, forceRerender])

  // ────── Formatting toggles ──────

  const toggleBold = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    updateCellStyle(selectedCell.r, selectedCell.c, { bold: !style.bold })
  }, [selectedCell, getCellStyle, updateCellStyle])

  const toggleItalic = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    updateCellStyle(selectedCell.r, selectedCell.c, { italic: !style.italic })
  }, [selectedCell, getCellStyle, updateCellStyle])

  const toggleUnderline = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    updateCellStyle(selectedCell.r, selectedCell.c, { underline: !style.underline })
  }, [selectedCell, getCellStyle, updateCellStyle])

  const changeFontSize = useCallback((size) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { fontSize: size })
  }, [selectedCell, updateCellStyle])

  const changeAlignment = useCallback((align) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { align })
  }, [selectedCell, updateCellStyle])

  const changeFontColor = useCallback((color) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { color })
  }, [selectedCell, updateCellStyle])

  const changeBackgroundColor = useCallback((color) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { bg: color })
  }, [selectedCell, updateCellStyle])

  // ────── Clear operations ──────

  const clearSelectedCell = useCallback(() => {
    if (!selectedCell) return
    engine.setCell(selectedCell.r, selectedCell.c, '')
    forceRerender()
    // Remove style entry for cleared cell
    // Note: This deletes the style object entirely - if you need to preserve default styles,
    // you may want to set them explicitly rather than deleting
    const key = `${selectedCell.r},${selectedCell.c}`
    setCellStyles(prev => { const next = { ...prev }; delete next[key]; return next })
    setEditValue('')
  }, [selectedCell, engine, forceRerender])

  const clearAllCells = useCallback(() => {
    for (let r = 0; r < engine.rows; r++) {
      for (let c = 0; c < engine.cols; c++) {
        engine.setCell(r, c, '')
      }
    }
    forceRerender()
    setCellStyles({})
    setSelectedCell(null)
    setSelectionEnd(null)
    setEditingCell(null)
    setEditValue('')
  }, [engine, forceRerender])

  // ────── Sample data (fixtures/sales.tsv) ──────

  const loadSample = useCallback((loader) => {
    loader(engine)
    forceRerender()
    setSelectedCell({ r: 0, c: 0 })
    setSelectionEnd({ r: 0, c: 0 })
    setEditingCell(null)
    setEditValue('')
  }, [engine, forceRerender])

  // ────── Row / Column operations ──────

  const insertRow = useCallback(() => {
    if (!selectedCell) return
    engine.insertRow(selectedCell.r)
    forceRerender()
    setSelectedCell({ r: selectedCell.r + 1, c: selectedCell.c })
  }, [selectedCell, engine, forceRerender])

  const deleteRow = useCallback(() => {
    if (!selectedCell) return
    engine.deleteRow(selectedCell.r)
    forceRerender()
    if (selectedCell.r >= engine.rows) {
      setSelectedCell({ r: engine.rows - 1, c: selectedCell.c })
    }
  }, [selectedCell, engine, forceRerender])

  const insertColumn = useCallback(() => {
    if (!selectedCell) return
    engine.insertColumn(selectedCell.c)
    forceRerender()
    setSelectedCell({ r: selectedCell.r, c: selectedCell.c + 1 })
  }, [selectedCell, engine, forceRerender])

  const deleteColumn = useCallback(() => {
    if (!selectedCell) return
    engine.deleteColumn(selectedCell.c)
    forceRerender()
    if (selectedCell.c >= engine.cols) {
      setSelectedCell({ r: selectedCell.r, c: engine.cols - 1 })
    }
  }, [selectedCell, engine, forceRerender])

  // ────── Derived state ──────

  const selectionBounds = useMemo(() => {
    if (!selectedCell) return null
    const end = selectionEnd || selectedCell
    return {
      minRow: Math.min(selectedCell.r, end.r),
      maxRow: Math.max(selectedCell.r, end.r),
      minCol: Math.min(selectedCell.c, end.c),
      maxCol: Math.max(selectedCell.c, end.c),
    }
  }, [selectedCell, selectionEnd])

  // Fill in any of four directions. All edited values are one engine undo entry.
  const finishFill = useCallback(() => {
    const drag = fillDragRef.current
    fillDragRef.current = null
    setFillTarget(null)
    isDraggingRef.current = false
    if (!drag?.target) return
    const { bounds, target } = drag
    const vertical = target.r < bounds.minRow || target.r > bounds.maxRow
    const horizontal = target.c < bounds.minCol || target.c > bounds.maxCol
    if (!vertical && !horizontal) return
    const axis = vertical && horizontal
      ? Math.abs(target.r - (target.r < bounds.minRow ? bounds.minRow : bounds.maxRow)) >=
        Math.abs(target.c - (target.c < bounds.minCol ? bounds.minCol : bounds.maxCol)) ? 'row' : 'col'
      : vertical ? 'row' : 'col'
    const changes = [], styles = {}
    if (axis === 'row') {
      const down = target.r > bounds.maxRow
      const sourceRows = Array.from({length:bounds.maxRow-bounds.minRow+1},(_,i)=>down?bounds.minRow+i:bounds.maxRow-i)
      const first = down ? bounds.maxRow+1 : target.r
      const last = down ? target.r : bounds.minRow-1
      for(let c=bounds.minCol;c<=bounds.maxCol;c++) {
        const seeds=sourceRows.map(r=>engine.getCell(r,c).raw)
        for(let r=first;r<=last;r++) {
          const index=down?r-bounds.minRow:bounds.maxRow-r
          const sourceIndex=((index%seeds.length)+seeds.length)%seeds.length
          const sourceRow=sourceRows[sourceIndex], raw=seeds[sourceIndex]
          const value=raw.startsWith('=')?shiftFillFormula(raw,r-sourceRow,0):extendFillValue(seeds,index)
          changes.push({row:r,col:c,value})
          if(cellStyles[`${sourceRow},${c}`])styles[`${r},${c}`]={...cellStyles[`${sourceRow},${c}`]}
        }
      }
    } else {
      const right=target.c>bounds.maxCol
      const sourceCols=Array.from({length:bounds.maxCol-bounds.minCol+1},(_,i)=>right?bounds.minCol+i:bounds.maxCol-i)
      const first=right?bounds.maxCol+1:target.c
      const last=right?target.c:bounds.minCol-1
      for(let r=bounds.minRow;r<=bounds.maxRow;r++) {
        const seeds=sourceCols.map(c=>engine.getCell(r,c).raw)
        for(let c=first;c<=last;c++) {
          const index=right?c-bounds.minCol:bounds.maxCol-c
          const sourceIndex=((index%seeds.length)+seeds.length)%seeds.length
          const sourceCol=sourceCols[sourceIndex],raw=seeds[sourceIndex]
          const value=raw.startsWith('=')?shiftFillFormula(raw,0,c-sourceCol):extendFillValue(seeds,index)
          changes.push({row:r,col:c,value})
          if(cellStyles[`${r},${sourceCol}`])styles[`${r},${c}`]={...cellStyles[`${r},${sourceCol}`]}
        }
      }
    }
    engine.ensureCapacity(Math.max(engine.rows,target.r+1),Math.max(engine.cols,target.c+1))
    engine.setCells(changes)
    if(Object.keys(styles).length)setCellStyles(prev=>({...prev,...styles}))
    setSelectedCell({r:Math.min(bounds.minRow,target.r),c:Math.min(bounds.minCol,target.c)})
    setSelectionEnd({r:Math.max(bounds.maxRow,target.r),c:Math.max(bounds.maxCol,target.c)})
    forceRerender()
  }, [engine,cellStyles,forceRerender])

  // Capture mouse release even when the pointer leaves the grid.
  // React's grid onMouseUp alone can miss the end of a fill drag.
  const finishFillRef = useRef(finishFill)
  useEffect(() => { finishFillRef.current = finishFill }, [finishFill])
  useEffect(() => {
    const onGlobalMouseUp = () => {
      isDraggingRef.current = false
      if (fillDragRef.current) finishFillRef.current()
    }
    window.addEventListener('mouseup', onGlobalMouseUp)
    return () => window.removeEventListener('mouseup', onGlobalMouseUp)
  }, [])

  // Spreadsheet keyboard commands when no text input is focused.
  useEffect(() => {
    const onKey = event => {
      const el=event.target
      if (['INPUT','TEXTAREA','SELECT'].includes(el?.tagName) || el?.isContentEditable) return
      const command=event.ctrlKey||event.metaKey
      if(command && event.key.toLowerCase()==='z') {
        event.preventDefault()
        if(event.shiftKey)handleRedo();else handleUndo()
        return
      }
      if(command && event.key.toLowerCase()==='y') {event.preventDefault();handleRedo();return}
      if(!selectedCell)return
      if(command && event.key.toLowerCase()==='a') {
        event.preventDefault()
        let maxR=0,maxC=0
        // Challenge 1 uses a small fixed sheet; inspect only its 50x50 cells.
        for(let r=0;r<engine.rows;r++)for(let c=0;c<engine.cols;c++)if(engine.getCell(r,c).raw){maxR=Math.max(maxR,r);maxC=Math.max(maxC,c)}
        setSelectedCell({r:0,c:0});setSelectionEnd({r:maxR,c:maxC});return
      }
      if(event.key==='Delete'||event.key==='Backspace') {
        event.preventDefault()
        if(!selectionBounds)return
        const changes=[]
        for(let r=selectionBounds.minRow;r<=selectionBounds.maxRow;r++)for(let c=selectionBounds.minCol;c<=selectionBounds.maxCol;c++)
          if(engine.getCell(r,c).raw)changes.push({row:r,col:c,value:''})
        engine.setCells(changes);forceRerender();return
      }
      if(event.key.startsWith('Arrow')) {
        const delta={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[event.key]
        if(!delta)return
        event.preventDefault()
        const origin=event.shiftKey?(selectionEnd||selectedCell):selectedCell
        const next={r:Math.max(0,Math.min(engine.rows-1,origin.r+delta[0])),c:Math.max(0,Math.min(engine.cols-1,origin.c+delta[1]))}
        if(!event.shiftKey)setSelectedCell(next)
        setSelectionEnd(next);return
      }
      if(event.key==='F2'||event.key==='Enter'){event.preventDefault();startEditing(selectedCell.r,selectedCell.c);return}
      if(!command&&!event.altKey&&event.key.length===1){event.preventDefault();startEditing(selectedCell.r,selectedCell.c);setEditValue(event.key)}
    }
    window.addEventListener('keydown',onKey)
    return ()=>window.removeEventListener('keydown',onKey)
  },[engine,selectedCell,selectionEnd,selectionBounds,handleUndo,handleRedo,forceRerender,startEditing])

  const selectedCellStyle = useMemo(() => {
    return selectedCell ? getCellStyle(selectedCell.r, selectedCell.c) : null
  }, [selectedCell, getCellStyle])

  const getColumnLabel = useCallback((col) => {
    let label = ''
    let num = col + 1
    while (num > 0) {
      num--
      label = String.fromCharCode(65 + (num % 26)) + label
      num = Math.floor(num / 26)
    }
    return label
  }, [])

  const selectedCellLabel = selectedCell
    ? `${getColumnLabel(selectedCell.c)}${selectedCell.r + 1}`
    : 'No cell'

  // Formula bar shows the raw formula text, not the computed value
  // When editing, show the current editValue; otherwise show the cell's raw content
  // Note: This is different from the cell display, which shows computed values
  const formulaBarValue = editingCell
    ? editValue
    : (selectedCell ? engine.getCell(selectedCell.r, selectedCell.c).raw : '')

  // ────── Render ──────

  return (
    <div className="app-wrapper">
      <div className="app-header">
        <h2 className="app-title">📊 Spreadsheet App</h2>
      </div>

      <div className="main-content">

        {/* ── Toolbar ── */}
        <div className="toolbar">
          <div className="toolbar-group">
            <button className={`toolbar-btn bold-btn ${selectedCellStyle?.bold ? 'active' : ''}`} onClick={toggleBold} title="Bold">B</button>
            <button className={`toolbar-btn italic-btn ${selectedCellStyle?.italic ? 'active' : ''}`} onClick={toggleItalic} title="Italic">I</button>
            <button className={`toolbar-btn underline-btn ${selectedCellStyle?.underline ? 'active' : ''}`} onClick={toggleUnderline} title="Underline">U</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Size:</span>
            <select className="toolbar-select" value={selectedCellStyle?.fontSize || 13} onChange={(e) => changeFontSize(parseInt(e.target.value))}>
              {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="toolbar-group">
            <button className={`align-btn ${selectedCellStyle?.align === 'left' ? 'active' : ''}`} onClick={() => changeAlignment('left')} title="Align Left">⬤←</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'center' ? 'active' : ''}`} onClick={() => changeAlignment('center')} title="Align Center">⬤</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'right' ? 'active' : ''}`} onClick={() => changeAlignment('right')} title="Align Right">⬤→</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Text:</span>
            <input
              type="color"
              value={selectedCellStyle?.color || '#000000'}
              onChange={(e) => changeFontColor(e.target.value)}
              title="Font color"
              style={{ width: '32px', height: '32px', border: '1px solid #dadce0', cursor: 'pointer', borderRadius: '4px' }}
            />
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Fill:</span>
            <select className="toolbar-select" value={selectedCellStyle?.bg || 'white'} onChange={(e) => changeBackgroundColor(e.target.value)}>
              <option value="white">White</option>
              <option value="#ffff99">Yellow</option>
              <option value="#99ffcc">Green</option>
              <option value="#ffcccc">Red</option>
              <option value="#cce5ff">Blue</option>
              <option value="#e0ccff">Purple</option>
              <option value="#ffd9b3">Orange</option>
              <option value="#f0f0f0">Gray</option>
            </select>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={handleUndo} disabled={!engine.canUndo()} title="Undo">↶ Undo</button>
            <button className="toolbar-btn" onClick={handleRedo} disabled={!engine.canRedo()} title="Redo">↷ Redo</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={insertRow} title="Insert Row">+ Row</button>
            <button className="toolbar-btn" onClick={deleteRow} title="Delete Row">- Row</button>
            <button className="toolbar-btn" onClick={insertColumn} title="Insert Column">+ Col</button>
            <button className="toolbar-btn" onClick={deleteColumn} title="Delete Column">- Col</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn danger" onClick={clearSelectedCell}>✕ Cell</button>
            <button className="toolbar-btn danger" onClick={clearAllCells}>✕ All</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleSmall)} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleLarge)} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
          </div>
        </div>

        {/* ── Formula Bar ── */}
        <div className="formula-bar">
          <span className="formula-bar-label">{selectedCellLabel}</span>
          <input
            className="formula-bar-input"
            value={formulaBarValue}
            onChange={(e) => handleFormulaBarChange(e.target.value)}
            onKeyDown={handleFormulaBarKeyDown}
            onFocus={handleFormulaBarFocus}
            placeholder="Select a cell then type, or enter a formula like =SUM(A1:A5)"
          />
        </div>

        {/* ── Grid ── */}
        <div className="grid-scroll" onMouseUp={() => { handleCellMouseUp(); finishFill() }} onMouseLeave={handleCellMouseUp}>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="col-header-blank"></th>
                {Array.from({ length: engine.cols }, (_, colIndex) => (
                  <th key={colIndex} className="col-header">
                    {getColumnLabel(colIndex)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: engine.rows }, (_, rowIndex) => (
                <tr key={rowIndex}>
                  <td className="row-header">{rowIndex + 1}</td>
                  {Array.from({ length: engine.cols }, (_, colIndex) => {
                    const isSelected = Boolean(selectionBounds &&
                      rowIndex >= selectionBounds.minRow &&
                      rowIndex <= selectionBounds.maxRow &&
                      colIndex >= selectionBounds.minCol &&
                      colIndex <= selectionBounds.maxCol)
                    const isEditing = editingCell?.r === rowIndex && editingCell?.c === colIndex
                    const cellData = engine.getCell(rowIndex, colIndex)
                    const style = cellStyles[`${rowIndex},${colIndex}`] || {}
                    const displayValue = cellData.error
                      ? cellData.error
                      : (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)

                    return (
                      <td
                        key={colIndex}
                        className={`cell ${isSelected ? 'selected' : ''} ${fillTarget && selectionBounds && ((colIndex >= selectionBounds.minCol && colIndex <= selectionBounds.maxCol && ((rowIndex > selectionBounds.maxRow && rowIndex <= fillTarget.r) || (rowIndex < selectionBounds.minRow && rowIndex >= fillTarget.r))) || (rowIndex >= selectionBounds.minRow && rowIndex <= selectionBounds.maxRow && ((colIndex > selectionBounds.maxCol && colIndex <= fillTarget.c) || (colIndex < selectionBounds.minCol && colIndex >= fillTarget.c)))) ? 'selected' : ''}`}
                        style={{ background: style.bg || 'white', position: 'relative' }}
                        onMouseDown={(e) => {
                          if (e.target.tagName === 'INPUT') return
                          e.preventDefault()
                          if (fillDragRef.current) return
                          isDraggingRef.current = true
                          handleCellClick(rowIndex, colIndex, e.shiftKey)
                        }}
                        onMouseEnter={() => handleCellMouseEnter(rowIndex, colIndex)}
                        onMouseUp={handleCellMouseUp}
                        onDoubleClick={() => handleCellDoubleClick(rowIndex, colIndex)}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            className="cell-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(rowIndex, colIndex)}
                            onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                            ref={editingCell?.r === rowIndex && editingCell?.c === colIndex ? cellInputRef : undefined}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: style.color || '#202124',
                              fontSize: (style.fontSize || 13) + 'px',
                              textAlign: style.align || 'left',
                              background: style.bg || 'white',
                            }}
                          />
                        ) : (
                          <div
                            className={`cell-display align-${style.align || 'left'} ${cellData.error ? 'error' : ''}`}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: cellData.error ? '#d93025' : (style.color || '#202124'),
                              fontSize: (style.fontSize || 13) + 'px',
                            }}
                          >
                            {displayValue}
                          </div>
                        )}
                        {isSelected && selectionBounds && rowIndex === selectionBounds.maxRow && colIndex === selectionBounds.maxCol && !isEditing && (
                          <span
                            title="Drag to autofill in any direction"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              isDraggingRef.current = false
                              fillDragRef.current = { bounds: { ...selectionBounds }, target: { r: rowIndex, c: colIndex } }
                            }}
                            style={{ position: 'absolute', width: 9, height: 9, right: -4, bottom: -4, background: '#1a73e8', border: '1px solid white', cursor: 'crosshair', zIndex: 5 }}
                          />
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="footer-hint">
          Click to select · Double-click to edit · Drag blue square in any direction to fill · Formulas: =A1+B1 · =SUM(A1:A5) · =AVG(A1:A5) · =MAX(A1:A5) · =MIN(A1:A5)
        </p>
      </div>
    </div>
  )
}
