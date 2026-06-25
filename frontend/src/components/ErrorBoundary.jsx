// (c) William Li 2026
import { Component } from 'react'

/**
 * Minimal error boundary. A render throw inside `children` is caught here and
 * rendered as `fallback` (a function of the error) instead of unmounting the
 * whole React tree — which otherwise leaves the browser tab blank. Used to wrap
 * the validation-detail modal so a bad message interpretation can't take down
 * the app; reset it by changing `resetKey`.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback(this.state.error)
        : this.props.fallback ?? null
    }
    return this.props.children
  }
}
