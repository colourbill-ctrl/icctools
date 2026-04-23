import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import styles from './TextEditor.module.css'

/**
 * Thin CodeMirror 6 wrapper used by both XmlPanel and JsonPanel.
 *
 * - `language` is a CodeMirror extension (e.g. xml() or json()). Passed in
 *   by the caller so each panel keeps its own syntax bundle out of the
 *   other's lazy chunk.
 * - External `value` updates patch the doc without re-creating the view so
 *   scroll position and undo history survive a "Convert to X" click.
 */
export default function TextEditor({ value, language, onChange }) {
  const hostRef = useRef(null)
  const viewRef = useRef(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language,
          EditorView.updateListener.of((v) => {
            if (v.docChanged) onChangeRef.current(v.state.doc.toString())
          }),
          EditorView.theme({
            '&': { fontSize: '12px', height: '100%' },
            '.cm-scroller': { fontFamily: 'var(--font-mono)' },
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className={styles.editor} />
}
