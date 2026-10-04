import CurvyLoader from '../CurvyLoader';
import { cn } from '@/lib/utils';

/**
 * Loading spinner. Curvy crawls while content loads.
 * Kept as `Spinner` so every existing usage picks up the mascot automatically.
 */
const Spinner = ({
  className,
  width = 20,
  height = 20,
}: {
  className?: string;
  baseColor?: string;
  spinnerColor?: string;
  width?: React.CSSProperties['width'];
  height?: React.CSSProperties['height'];
}) => {
  const size =
    typeof width === 'number' && typeof height === 'number'
      ? Math.max(width, height)
      : 32;
  return <CurvyLoader size={size} className={cn(className)} />;
};

export default Spinner;
