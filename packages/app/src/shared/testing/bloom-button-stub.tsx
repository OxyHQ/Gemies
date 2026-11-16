import React from 'react';

/** Actions rendered as hosts for app behavior tests; grouping uses the same button. */
export function buttonModule() {
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement(name, props, children);
  return { Button: Object.assign(host('Button'), { Group: host('ButtonGroup') }) };
}
