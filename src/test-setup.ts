// jsdom has no layout engine; give the virtualized table a viewport and polyfill browser APIs it uses.
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver = NoopResizeObserver;
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
