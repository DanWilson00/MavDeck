import 'solid-js';

declare module 'solid-js' {
  namespace JSX {
    interface ExplicitProperties {
      value?: string | number;
    }
  }
}
