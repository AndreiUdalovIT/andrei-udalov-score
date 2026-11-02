'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from 'lucide-react';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      // Below lg, clear the tab bar, its border and safe area with a 1rem gap.
      className="toaster group
        max-lg:data-[y-position=bottom]:bottom-[calc(5rem+1px+env(safe-area-inset-bottom))]!"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      // Inverted toast from the design sheet: dark on light, light on dark.
      style={
        {
          '--normal-bg': 'var(--foreground)',
          '--normal-text': 'var(--background)',
          '--normal-border': 'transparent',
          '--border-radius': '10px',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
          // «Вернуть» from the design: a plain underlined word, not a pill.
          actionButton: `bg-transparent! font-semibold! text-(--normal-text)! underline
          underline-offset-3`,
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
