import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'

const TOTAL_ROWS = 50
const TOTAL_COLS = 50
const VIRTUAL_ROW_HEIGHT = 32
const VIRTUAL_OVERSCAN = 10

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

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function matchCase(template, word) {
  return template === template.toUpperCase() ? word.toUpperCase()
    : template === template.toLowerCase() ? word.toLowerCase()
      : template[0] === template[0].toLowerCase() ? word[0].toLowerCase() + word.slice(1) : word
}
function parseFillDate(value) {
  const text = String(value)
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return { time: Date.UTC(+m[1], +m[2]-1, +m[3]), kind: 'iso', widths: [m[2].length,m[3].length] }
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return { time: Date.UTC(+m[3], +m[1]-1, +m[2]), kind: 'us', widths: [m[1].length,m[2].length] }
  m = text.match(/^(\d{1,2}) ([A-Za-z]{3,}) (\d{4})$/)
  if (m) {
    const month = MONTHS.findIndex(v => v.toLowerCase().startsWith(m[2].toLowerCase()))
    if (month >= 0) return { time: Date.UTC(+m[3], month, +m[1]), kind: 'text', widths: [m[1].length], monthText: m[2] }
  }
  return null
}
function renderFillDate(seed, time) {
  const d = new Date(time), y = d.getUTCFullYear(), m = d.getUTCMonth()+1, day = d.getUTCDate()
  const pad = (v, width) => String(v).padStart(width, '0')
  if (seed.kind === 'iso') return `${y}-${pad(m,seed.widths[0])}-${pad(day,seed.widths[1])}`
  if (seed.kind === 'us') return `${pad(m,seed.widths[0])}/${pad(day,seed.widths[1])}/${y}`
  const month = MONTHS[m-1].slice(0,seed.monthText.length)
  return `${pad(day,seed.widths[0])} ${matchCase(seed.monthText,month)} ${y}`
}
function extendFillValue(seedValues, index) {
  const seeds = seedValues.map(v => String(v ?? ''))
  const first = seeds[0]
  if (seeds.length === 1 && !first) return ''
  if (seeds.every(v => v.trim() !== '' && Number.isFinite(Number(v)))) {
    const step = seeds.length > 1 ? Number(seeds[1]) - Number(first) : 0
    return String(Number(first) + step * index)
  }
  const dates = seeds.map(parseFillDate)
  if (dates.every(Boolean)) {
    const step = dates.length > 1 ? dates[1].time - dates[0].time : 86400000
    return renderFillDate(dates[0], dates[0].time + step * index)
  }
  const suffixes = seeds.map(v => v.match(/^(.*?)(\d+)$/))
  if (suffixes.every(Boolean) && suffixes.every(v => v[1] === suffixes[0][1])) {
    const step = suffixes.length > 1 ? Number(suffixes[1][2]) - Number(suffixes[0][2]) : 1
    const value = Number(suffixes[0][2]) + step * index
    return suffixes[0][1] + String(value).padStart(suffixes[0][2].length, '0')
  }
  for (const words of [WEEKDAYS, MONTHS]) {
    const indices = seeds.map(v => words.findIndex(w => w.toLowerCase() === v.toLowerCase() || w.slice(0,3).toLowerCase() === v.toLowerCase()))
    if (indices.every(i => i >= 0)) {
      const step = seeds.length > 1 ? (indices[1] - indices[0] + words.length) % words.length : 1
      const position = ((indices[0] + step * index) % words.length + words.length) % words.length
      return matchCase(first, words[position].slice(0, first.length))
    }
  }
  return seeds[((index % seeds.length) + seeds.length) % seeds.length]
}

// Challenge 4: transparent, local natural-language query interpreter (no external AI API).
function interpretSheetQuery(input, columns) {
  const query = input.trim()
  const lower = query.toLowerCase()
  if (!query) return { error: 'Enter a spreadsheet question or command.' }
  const columnMatch = lower.match(/\b(?:column|col)\s+([a-z]{1,3})\b/) || lower.match(/\b([a-z]{1,3})\s+column\b/)
  let col = -1
  if (columnMatch) {
    col = [...columnMatch[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  } else {
    // Allow bare single-letter references for queries such as "sum B".
    const match = lower.match(/\b(?:sum|total|average|avg|mean|minimum|min|maximum|max|count|sort|filter)\s+(?:of\s+)?([a-z])\b/)
    if (match) col = match[1].toUpperCase().charCodeAt(0) - 65
  }
  if (/\b(reset|clear)\s+(?:the\s+)?(?:view|filters?|sorting)\b/.test(lower) || lower === 'show all rows') return { type: 'reset' }
  if (/\b(hide empty|nonempty|non-empty)\b/.test(lower)) return { type: 'hideEmpty' }
  if (col < 0 || col >= columns) return { error: 'Please specify a valid column, such as A, B, or C.' }
  if (/\b(sort|order|rank)\b/.test(lower)) {
    const desc = /\b(desc|descending|highest|largest|biggest|z\s*to\s*a|high to low|decreasing)\b/.test(lower)
    return { type: 'sort', col, direction: desc ? 'desc' : 'asc' }
  }
  if (/\b(filter|find|show|contains?|search)\b/.test(lower)) {
    const term = query.match(/\b(?:for|containing|contains|equals|equal to|matching|with|is)\s+["']?(.+?)["']?\s*$/i)
    if (!term) return { error: 'Try: filter column A for Alice' }
    return { type: 'filter', col, term: term[1].trim().replace(/^["']|["']$/g, '') }
  }
  const aggregate = /\b(average|avg|mean)\b/.test(lower) ? 'average'
    : /\b(sum|total)\b/.test(lower) ? 'sum'
    : /\b(count|how many)\b/.test(lower) ? 'count'
    : /\b(minimum|min|smallest|lowest)\b/.test(lower) ? 'min'
    : /\b(maximum|max|largest|highest)\b/.test(lower) ? 'max' : null
  if (aggregate) return { type: 'aggregate', col, aggregate }
  return { error: 'Supported: sum, average, count, min, max, sort, filter, hide empty, and reset view.' }
}

// Display formatting never changes the underlying numeric value or formula.
function formatCellDisplay(value, format) {
  if (!format || format === 'general') return value
  const text = String(value ?? '')
  if (!text.trim() || !Number.isFinite(Number(text))) return value
  const number = Number(text)
  if (format === 'integer') return number.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (format === 'decimal') return number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (format === 'currency') return number.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  if (format === 'percent') return number.toLocaleString('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return value
}

export default function App() {
  // Engine instance is created once and reused across renders
  // Note: The engine maintains its own internal state, so React state is only used for UI updates
  const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [version, setVersion] = useState(0)
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
  // Challenge 2: sorting and filtering are non-destructive views.
  // Physical cell coordinates, formulas and styles remain unchanged.
  const [sortColumn, setSortColumn] = useState(0)
  const [sortDirection, setSortDirection] = useState('none')
  const [filterColumn, setFilterColumn] = useState(0)
  const [filterText, setFilterText] = useState('')
  const [hideEmpty, setHideEmpty] = useState(false)
  const [columnFilters, setColumnFilters] = useState({})
  const [filterOp, setFilterOp] = useState('contains')
  const [sortMessage, setSortMessage] = useState('')
  const gridScrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(560)
  const [queryText, setQueryText] = useState('')
  const [queryResult, setQueryResult] = useState('Try "sum column B" or "filter column A for Alice".')


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

  useEffect(() => {
    const onKey = event => {
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) handleRedo(); else handleUndo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); handleRedo(); return }
      if (!selectedCell) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        let maxR=0,maxC=0
        for (let r=0;r<engine.rows;r++) for (let c=0;c<engine.cols;c++) {
          if (engine.getCell(r,c).raw) { maxR=Math.max(maxR,r); maxC=Math.max(maxC,c) }
        }
        setSelectedCell({r:0,c:0}); setSelectionEnd({r:maxR,c:maxC})
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        const bounds=selectionBounds
        if (!bounds) return
        const changes=[]
        for(let r=bounds.minRow;r<=bounds.maxRow;r++) for(let c=bounds.minCol;c<=bounds.maxCol;c++) {
          if(engine.getCell(r,c).raw) changes.push({row:r,col:c,value:''})
        }
        engine.setCells(changes); forceRerender(); return
      }
      if (event.key.startsWith('Arrow')) {
        event.preventDefault()
        const delta = {ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[event.key]
        if (!delta) return
        const origin = event.shiftKey ? (selectionEnd || selectedCell) : selectedCell
        const next={r:Math.max(0,Math.min(engine.rows-1,origin.r+delta[0])),c:Math.max(0,Math.min(engine.cols-1,origin.c+delta[1]))}
        if (!event.shiftKey) setSelectedCell(next)
        setSelectionEnd(next)
        return
      }
      if (event.key === 'F2' || event.key === 'Enter') {
        event.preventDefault(); startEditing(selectedCell.r,selectedCell.c); return
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
        event.preventDefault()
        startEditing(selectedCell.r,selectedCell.c)
        setEditValue(event.key)
      }
    }
    window.addEventListener('keydown',onKey)
    return ()=>window.removeEventListener('keydown',onKey)
  },[engine,selectedCell,selectionEnd,selectionBounds,handleUndo,handleRedo,forceRerender,startEditing])

  // Challenge 5: Apply formatting to every cell in the selected rectangle.
  // Keep the existing style attributes while changing only the requested ones.
  const applyRangeStyle = useCallback((updates) => {
    if (!selectionBounds) return
    setCellStyles(previous => {
      const next = { ...previous }
      for (let r = selectionBounds.minRow; r <= selectionBounds.maxRow; r++) {
        for (let c = selectionBounds.minCol; c <= selectionBounds.maxCol; c++) {
          const key = `${r},${c}`
          next[key] = { ...previous[key], ...updates }
        }
      }
      return next
    })
  }, [selectionBounds])

  const clearRangeFormatting = useCallback(() => {
    if (!selectionBounds) return
    setCellStyles(previous => {
      const next = { ...previous }
      for (let r = selectionBounds.minRow; r <= selectionBounds.maxRow; r++) {
        for (let c = selectionBounds.minCol; c <= selectionBounds.maxCol; c++) {
          delete next[`${r},${c}`]
        }
      }
      return next
    })
  }, [selectionBounds])

  const finishFill = useCallback(() => {
    const drag = fillDragRef.current
    fillDragRef.current = null
    setFillTarget(null)
    isDraggingRef.current = false
    if (!drag) return
    const { bounds, target } = drag
    if (!target) return
    const vertical = target.r < bounds.minRow || target.r > bounds.maxRow
    const horizontal = target.c < bounds.minCol || target.c > bounds.maxCol
    if (!vertical && !horizontal) return
    const axis = vertical && horizontal
      ? (Math.abs(target.r - bounds.maxRow) >= Math.abs(target.c - bounds.maxCol) ? 'row' : 'col')
      : vertical ? 'row' : 'col'
    const changes = [], styleUpdates = {}
    if (axis === 'row') {
      const goingDown = target.r > bounds.maxRow
      const start = goingDown ? bounds.maxRow + 1 : target.r
      const end = goingDown ? target.r : bounds.minRow - 1
      for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
        const sourceRows = Array.from({ length: bounds.maxRow - bounds.minRow + 1 }, (_, i) => goingDown ? bounds.minRow + i : bounds.maxRow - i)
        const seeds = sourceRows.map(r => engine.getCell(r,c).raw)
        for (let r = start; r <= end; r++) {
          const index = goingDown ? r - bounds.minRow : bounds.maxRow - r
          const seedIndex = ((index % seeds.length) + seeds.length) % seeds.length
          const sourceRow = sourceRows[seedIndex]
          const raw = seeds[seedIndex]
          const value = raw.startsWith('=') ? shiftFillFormula(raw,r-sourceRow,0) : extendFillValue(seeds,index)
          changes.push({row:r,col:c,value})
          const sourceStyle = cellStyles[`${sourceRow},${c}`]
          if (sourceStyle) styleUpdates[`${r},${c}`] = {...sourceStyle}
        }
      }
    } else {
      const goingRight = target.c > bounds.maxCol
      const start = goingRight ? bounds.maxCol + 1 : target.c
      const end = goingRight ? target.c : bounds.minCol - 1
      for (let r = bounds.minRow; r <= bounds.maxRow; r++) {
        const sourceCols = Array.from({length:bounds.maxCol-bounds.minCol+1},(_,i)=>goingRight?bounds.minCol+i:bounds.maxCol-i)
        const seeds = sourceCols.map(c=>engine.getCell(r,c).raw)
        for (let c=start;c<=end;c++) {
          const index = goingRight ? c-bounds.minCol : bounds.maxCol-c
          const seedIndex = ((index % seeds.length) + seeds.length) % seeds.length
          const sourceCol = sourceCols[seedIndex], raw = seeds[seedIndex]
          const value = raw.startsWith('=') ? shiftFillFormula(raw,0,c-sourceCol) : extendFillValue(seeds,index)
          changes.push({row:r,col:c,value})
          const sourceStyle = cellStyles[`${r},${sourceCol}`]
          if (sourceStyle) styleUpdates[`${r},${c}`] = {...sourceStyle}
        }
      }
    }
    engine.ensureCapacity(Math.max(engine.rows,target.r+1),Math.max(engine.cols,target.c+1))
    engine.setCells(changes)
    if (Object.keys(styleUpdates).length) setCellStyles(prev=>({...prev,...styleUpdates}))
    setSelectedCell({r:Math.min(bounds.minRow,target.r),c:Math.min(bounds.minCol,target.c)})
    setSelectionEnd({r:Math.max(bounds.maxRow,target.r),c:Math.max(bounds.maxCol,target.c)})
    forceRerender()
  }, [engine, cellStyles, forceRerender])

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

  // Filtering is a non-destructive visibility mask. Row 1 and totals stay visible.
  const isTotalsRow = useCallback((r) => /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(String(engine.getCell(r,0).raw).trim()), [engine])
  const lastDataRow = useMemo(() => {
    for (let r = engine.rows - 1; r >= 1; r--) {
      for (let c = 0; c < engine.cols; c++) {
        if (String(engine.getCell(r,c).raw ?? '').trim()) return r
      }
    }
    return 0
  }, [engine, version])
  const totalsRow = lastDataRow > 0 && isTotalsRow(lastDataRow) ? lastDataRow : -1
  const matchesFilters = useCallback((r) => {
    for (const [column, filter] of Object.entries(columnFilters)) {
      const value = String(engine.getCell(r, Number(column)).computed ?? engine.getCell(r,Number(column)).raw ?? '').trim()
      const needle = filter.term.trim()
      const a = value.toLowerCase(), b = needle.toLowerCase()
      const an = Number(value.replace(/[$,%\s]/g,'')), bn = Number(needle.replace(/[$,%\s]/g,''))
      const numeric = value !== '' && needle !== '' && Number.isFinite(an) && Number.isFinite(bn)
      let ok = true
      if (filter.op === 'contains') ok = a.includes(b)
      else if (filter.op === 'eq') ok = numeric ? an === bn : a === b
      else if (filter.op === 'gt') ok = numeric && an > bn
      else if (filter.op === 'lt') ok = numeric && an < bn
      else if (filter.op === 'empty') ok = !value
      else if (filter.op === 'notEmpty') ok = Boolean(value)
      if (!ok) return false
    }
    return true
  }, [columnFilters, engine, version])
  const visibleRows = useMemo(() => {
    const result = []
    for (let r = 0; r < engine.rows; r++) {
      if (r === 0 || r === totalsRow) { result.push(r); continue }
      if (!matchesFilters(r)) continue
      if (hideEmpty) {
        let found = false
        for (let c = 0; c < engine.cols; c++) if (engine.getCell(r,c).raw) { found = true; break }
        if (!found) continue
      }
      result.push(r)
    }
    return result
  }, [engine, version, totalsRow, matchesFilters, hideEmpty])

  // A physical sort is one engine transaction; hidden rows remain at their coordinates.
  const physicalSort = useCallback((column, direction) => {
    const first = selectionBounds && selectionBounds.maxRow > selectionBounds.minRow ? Math.max(1, selectionBounds.minRow) : 1
    const last = selectionBounds && selectionBounds.maxRow > selectionBounds.minRow ? Math.min(lastDataRow, selectionBounds.maxRow) : lastDataRow
    const end = totalsRow >= 0 ? Math.min(last, totalsRow-1) : last
    const eligible = []
    for (let r = first; r <= end; r++) if (matchesFilters(r)) eligible.push(r)
    if (eligible.length < 2) { setSortMessage('Not enough matching data rows to sort.'); return }
    const valueAt = r => {
      const cell = engine.getCell(r,column)
      return String(cell.error ?? cell.computed ?? cell.raw ?? '').trim()
    }
    const original = eligible.map(r => ({ row:r, value:valueAt(r) }))
    const sorted = [...original].sort((a,b) => {
      if (!a.value || !b.value) return !a.value && !b.value ? a.row-b.row : !a.value ? 1 : -1
      const na = Number(a.value.replace(/[$,\s]/g,'')), nb = Number(b.value.replace(/[$,\s]/g,''))
      const isNa = Number.isFinite(na), isNb = Number.isFinite(nb)
      let cmp = isNa && isNb ? na-nb : isNa ? -1 : isNb ? 1 : a.value.localeCompare(b.value,undefined,{sensitivity:'base'})
      return (direction === 'desc' ? -cmp : cmp) || a.row-b.row
    })
    const changes = []
    const newStyles = { ...cellStyles }
    const snapshot = sorted.map(item => {
      const values = [], styles = []
      for (let c=0;c<engine.cols;c++) {
        values.push(engine.getCell(item.row,c).raw)
        styles.push(cellStyles[`${item.row},${c}`])
      }
      return { ...item, values, styles }
    })
    eligible.forEach((destination,i) => {
      const source = snapshot[i]
      for (let c=0;c<engine.cols;c++) {
        const raw = source.values[c]
        // Relative references in moved formulas follow the moved row.
        const value = typeof raw === 'string' && raw.startsWith('=') ? shiftFillFormula(raw,destination-source.row,0) : raw
        changes.push({row:destination,col:c,value})
        const key = `${destination},${c}`
        if (source.styles[c]) newStyles[key] = {...source.styles[c]}
        else delete newStyles[key]
      }
    })
    engine.setCells(changes)
    setCellStyles(newStyles)
    forceRerender()
    setSortMessage(`Physically sorted ${eligible.length} rows ${direction}; one Ctrl+Z restores cell values. Styles currently have separate undo.`)
  }, [engine, selectionBounds, lastDataRow, totalsRow, matchesFilters, cellStyles, forceRerender])

  // Challenge 3: Only mount rows intersecting the viewport plus overscan.
  // Preserve their original engine row IDs so formulas and edits stay correct.
  useEffect(() => {
    const element = gridScrollRef.current
    if (!element) return
    const measure = () => setViewportHeight(element.clientHeight || 560)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = gridScrollRef.current
    if (element) element.scrollTop = 0
    setScrollTop(0)
  }, [sortColumn, sortDirection, filterColumn, filterText, hideEmpty])

  const firstVisibleIndex = Math.min(
    visibleRows.length,
    Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN)
  )
  const lastVisibleIndex = Math.min(
    visibleRows.length,
    Math.ceil((scrollTop + viewportHeight) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN
  )
  const renderedRows = visibleRows.slice(firstVisibleIndex, lastVisibleIndex)
  const topSpacerHeight = firstVisibleIndex * VIRTUAL_ROW_HEIGHT
  const bottomSpacerHeight = (visibleRows.length - lastVisibleIndex) * VIRTUAL_ROW_HEIGHT

  const runSheetQuery = useCallback((event) => {
    event.preventDefault()
    const command = interpretSheetQuery(queryText, engine.cols)
    if (command.error) { setQueryResult(command.error); return }
    if (command.type === 'reset') {
      setSortDirection('none'); setFilterText(''); setHideEmpty(false); setColumnFilters({})
      setQueryResult('View reset. All rows are visible in their original order.')
      return
    }
    if (command.type === 'hideEmpty') {
      setHideEmpty(true)
      setQueryResult('Empty rows are now hidden. Use "reset view" to restore them.')
      return
    }
    const label = (() => { let n = command.col + 1, out = ''; while (n) { n--; out = String.fromCharCode(65 + n % 26) + out; n = Math.floor(n / 26) } return out })()
    if (command.type === 'sort') {
      setSortColumn(command.col); setSortDirection(command.direction); physicalSort(command.col, command.direction)
      setQueryResult(`Sorted the display by column ${label} (${command.direction === 'asc' ? 'ascending' : 'descending'}). Cell positions are unchanged.`)
      return
    }
    if (command.type === 'filter') {
      setFilterColumn(command.col); setFilterText(command.term); setColumnFilters(prev => ({...prev,[command.col]:{op:'contains',term:command.term}}))
      setQueryResult(`Showing rows where column ${label} contains "${command.term}".`)
      return
    }
    if (command.type === 'aggregate') {
      // Calculate against rows in the current view, ignoring blanks and nonnumeric values.
      const cells = visibleRows.map(r => engine.getCell(r, command.col))
      const nonblank = cells.map(c => String(c.error ?? c.computed ?? c.raw ?? '').trim()).filter(Boolean)
      const numeric = nonblank.map(Number).filter(Number.isFinite)
      const values = numeric
      let result
      if (command.aggregate === 'count') result = nonblank.length
      else if (!values.length) { setQueryResult(`No numeric values found in column ${label} within the current view.`); return }
      else if (command.aggregate === 'sum') result = values.reduce((a,b) => a+b, 0)
      else if (command.aggregate === 'average') result = values.reduce((a,b) => a+b, 0) / values.length
      else if (command.aggregate === 'min') result = Math.min(...values)
      else result = Math.max(...values)
      setQueryResult(`${command.aggregate.toUpperCase()} of column ${label}: ${Number(result.toPrecision(12)).toLocaleString()} (${command.aggregate === 'count' ? nonblank.length + ' nonempty cells' : numeric.length + ' numeric cells'} in the current view).`)
    }
  }, [queryText, engine, visibleRows, physicalSort])

  const viewIsModified = Object.keys(columnFilters).length > 0 || hideEmpty
  const resetView = () => {
    setSortDirection('none')
    setFilterText('')
    setHideEmpty(false)
    setColumnFilters({})
  }

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

        {/* ── Challenge 5: range formatting and numeric display formats ── */}
        <div aria-label="Range formatting" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#f8fafc', borderBottom: '1px solid #cbd5e1', fontSize: 13 }}>
          <strong>Format Selection</strong>
          <span style={{ color: '#64748b' }}>Select cells first; changes apply to the whole range.</span>
          <label>Number format{' '}
            <select aria-label="Number format" value={selectedCellStyle?.numberFormat || 'general'} disabled={!selectedCell} onChange={e => applyRangeStyle({ numberFormat: e.target.value })}>
              <option value="general">General</option>
              <option value="integer">Number (0 decimals)</option>
              <option value="decimal">Number (2 decimals)</option>
              <option value="currency">Currency (USD)</option>
              <option value="percent">Percentage</option>
            </select>
          </label>
          <label>Border{' '}
            <select aria-label="Cell borders" value={selectedCellStyle?.border || 'none'} disabled={!selectedCell} onChange={e => applyRangeStyle({ border: e.target.value })}>
              <option value="none">None</option>
              <option value="all">All borders</option>
              <option value="bottom">Bottom border</option>
              <option value="top">Top border</option>
            </select>
          </label>
          <button className="toolbar-btn" disabled={!selectedCell} onClick={() => applyRangeStyle({ bold: true })}>Bold range</button>
          <button className="toolbar-btn" disabled={!selectedCell} onClick={() => applyRangeStyle({ bg: '#fff2b3' })}>Highlight range</button>
          <button className="toolbar-btn" disabled={!selectedCell} onClick={clearRangeFormatting}>Clear formatting</button>
        </div>

        {/* ── Challenge 2: Sort and filter (non-destructive view) ── */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: '10px 12px', background: '#f1f5f9', borderBottom: '1px solid #d1d5db', fontSize: 13 }}>
          <strong>Sort &amp; Filter</strong>
          <label>Sort column{' '}
            <select aria-label="Sort column" value={sortColumn} onChange={e => setSortColumn(Number(e.target.value))}>
              {Array.from({ length: engine.cols }, (_, c) => <option key={c} value={c}>{getColumnLabel(c)}</option>)}
            </select>
          </label>
          <button className="toolbar-btn" onClick={() => physicalSort(sortColumn,'asc')}>Sort ascending (physical)</button>
          <button className="toolbar-btn" onClick={() => physicalSort(sortColumn,'desc')}>Sort descending (physical)</button>
          <label>Filter column{' '}
            <select aria-label="Filter column" value={filterColumn} onChange={e => setFilterColumn(Number(e.target.value))}>
              {Array.from({ length: engine.cols }, (_, c) => <option key={c} value={c}>{getColumnLabel(c)}</option>)}
            </select>
          </label>
          <select aria-label="Filter condition" value={filterOp} onChange={e => setFilterOp(e.target.value)}>
            <option value="contains">Contains</option><option value="eq">Equals</option><option value="gt">Greater than</option><option value="lt">Less than</option><option value="empty">Is empty</option><option value="notEmpty">Not empty</option>
          </select>
          <input aria-label="Filter text" placeholder="Filter value" value={filterText} onChange={e => setFilterText(e.target.value)} style={{ padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 4, width: 145 }} />
          <button className="toolbar-btn" onClick={() => setColumnFilters(prev => ({...prev,[filterColumn]:{op:filterOp,term:filterText}}))}>Apply filter</button>
          <button className="toolbar-btn" onClick={() => setColumnFilters(prev => { const next={...prev}; delete next[filterColumn]; return next })}>Clear column</button>
          <label><input type="checkbox" checked={hideEmpty} onChange={e => setHideEmpty(e.target.checked)} /> Hide empty rows</label>
          <button className="toolbar-btn" onClick={resetView}>Reset view</button>
          <span style={{ color: '#475569' }}>{visibleRows.length} of {engine.rows} rows · {renderedRows.length} mounted</span>
          {viewIsModified && <span style={{ color: '#9a3412' }}>Filters active · Fill handle disabled</span>}
          <span role="status">{sortMessage}</span>
        </div>

        {/* ── Challenge 4: local natural-language spreadsheet commands ── */}
        <form onSubmit={runSheetQuery} aria-label="Spreadsheet natural language queries" style={{ padding: '12px', background: '#eff6ff', borderBottom: '1px solid #bfdbfe' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <strong>Ask the Sheet</strong>
            <span style={{ color: '#475569', fontSize: 12 }}>Local command parser · no AI API required</span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input aria-label="Ask the Sheet query" value={queryText} onChange={e => setQueryText(e.target.value)} placeholder="e.g. average column B, sort column C descending" style={{ flex: 1, minWidth: 0, padding: '8px 10px', border: '1px solid #93c5fd', borderRadius: 5 }} />
            <button type="submit" className="toolbar-btn">Run query</button>
          </div>
          <div role="status" aria-live="polite" style={{ marginTop: 7, fontSize: 13, color: '#1e3a8a' }}>{queryResult}</div>
        </form>

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
        <div className="grid-scroll" ref={gridScrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} onMouseUp={() => { handleCellMouseUp(); finishFill() }} onMouseLeave={handleCellMouseUp} style={{ height: 'min(62vh, 620px)', overflow: 'auto' }}>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="col-header-blank"></th>
                {Array.from({ length: engine.cols }, (_, colIndex) => (
                  <th key={colIndex} className="col-header" onClick={() => { setSelectedCell({r:0,c:colIndex}); setSelectionEnd({r:engine.rows-1,c:colIndex}) }}>
                    {getColumnLabel(colIndex)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topSpacerHeight > 0 && (
                <tr aria-hidden="true" style={{ height: topSpacerHeight }}>
                  <td colSpan={engine.cols + 1} style={{ height: topSpacerHeight, padding: 0, border: 0, background: 'transparent' }} />
                </tr>
              )}
              {renderedRows.map(rowIndex => (
                <tr key={rowIndex} style={{ height: VIRTUAL_ROW_HEIGHT }}>
                  <td className="row-header" onClick={() => { setSelectedCell({r:rowIndex,c:0}); setSelectionEnd({r:rowIndex,c:engine.cols-1}) }}>{rowIndex + 1}</td>
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
                        className={`cell ${isSelected ? 'selected' : ''} ${fillTarget && selectionBounds && ((colIndex >= selectionBounds.minCol && colIndex <= selectionBounds.maxCol) && (rowIndex > selectionBounds.maxRow && rowIndex <= fillTarget.r || rowIndex < selectionBounds.minRow && rowIndex >= fillTarget.r) || rowIndex >= selectionBounds.minRow && rowIndex <= selectionBounds.maxRow && (colIndex > selectionBounds.maxCol && colIndex <= fillTarget.c || colIndex < selectionBounds.minCol && colIndex >= fillTarget.c)) ? 'selected' : ''}`}
                        style={{ background: style.bg || 'white', position: 'relative', boxShadow: style.border === 'all' ? 'inset 0 0 0 1px #64748b' : style.border === 'bottom' ? 'inset 0 -2px 0 #64748b' : style.border === 'top' ? 'inset 0 2px 0 #64748b' : undefined }}
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
                            {cellData.error ? displayValue : formatCellDisplay(displayValue, style.numberFormat)}
                          </div>
                        )}
                        {!viewIsModified && isSelected && selectionBounds && (rowIndex === selectionBounds.maxRow || rowIndex === selectionBounds.minRow) && (colIndex === selectionBounds.maxCol || colIndex === selectionBounds.minCol) && !isEditing && (
                          <span
                            title="Drag in any direction to fill cells"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              isDraggingRef.current = false
                              fillDragRef.current = { bounds: { ...selectionBounds }, target: { r: rowIndex, c: colIndex } }
                            }}
                            style={{ position: 'absolute', width: 9, height: 9, right: colIndex === selectionBounds.maxCol ? -4 : undefined, left: colIndex === selectionBounds.minCol ? -4 : undefined, bottom: rowIndex === selectionBounds.maxRow ? -4 : undefined, top: rowIndex === selectionBounds.minRow ? -4 : undefined, background: '#1a73e8', border: '1px solid white', cursor: 'crosshair', zIndex: 5 }}
                          />
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {bottomSpacerHeight > 0 && (
                <tr aria-hidden="true" style={{ height: bottomSpacerHeight }}>
                  <td colSpan={engine.cols + 1} style={{ height: bottomSpacerHeight, padding: 0, border: 0, background: 'transparent' }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="footer-hint">
          Click to select · Double-click to edit · Drag blue square to fill in any direction (normal view) · Sorting moves sheet values; filtering hides rows without deleting them · Formulas: =A1+B1 · =SUM(A1:A5) · =AVG(A1:A5) · =MAX(A1:A5) · =MIN(A1:A5)
        </p>
      </div>
    </div>
  )
}
