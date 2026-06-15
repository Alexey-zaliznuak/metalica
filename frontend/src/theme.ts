import { createTheme, alpha } from '@mui/material/styles'

// Material blue palette for "Металлика".
// Deep → bright → light → pale, plus standard semantic accents
// (blue messages, orange revisions, green resolutions).
export const BRAND = {
  deep: '#2C5EAD', // rgb(44, 94, 173)
  main: '#1591DC', // rgb(21, 145, 220)
  light: '#4BB8FA', // rgb(75, 184, 250)
  pale: '#C4E2F5', // rgb(196, 226, 245)
}

// Semantic accents reused across the app (messages / revisions / resolutions).
export const ACCENT = {
  message: BRAND.main,
  revision: '#ED6C02', // standard orange
  revisionSoft: '#FFF3E5',
  resolution: '#2E7D32', // standard green
  resolutionSoft: '#EAF5EB',
}

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: BRAND.main,
      light: BRAND.light,
      dark: BRAND.deep,
      contrastText: '#ffffff',
    },
    secondary: {
      main: BRAND.deep,
      light: BRAND.light,
      dark: '#1f4684',
      contrastText: '#ffffff',
    },
    info: {
      main: BRAND.main,
      light: BRAND.light,
      dark: BRAND.deep,
      contrastText: '#ffffff',
    },
    success: {
      main: ACCENT.resolution,
      light: '#4caf50',
      dark: '#1b5e20',
      contrastText: '#ffffff',
    },
    warning: {
      main: ACCENT.revision,
      light: '#ff9800',
      dark: '#c75800',
      contrastText: '#ffffff',
    },
    error: {
      main: '#d32f2f',
    },
    background: {
      default: '#eef5fc',
      paper: '#ffffff',
    },
    text: {
      primary: '#15263b',
      secondary: '#5a7088',
    },
    divider: alpha(BRAND.deep, 0.12),
  },
  shape: {
    borderRadius: 8,
  },
  typography: {
    fontFamily:
      '"Inter","Roboto","Helvetica","Arial",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontWeight: 700, letterSpacing: '-0.01em' },
    h6: { fontWeight: 700 },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 600 },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundImage: `radial-gradient(1200px 600px at 100% -10%, ${alpha(
            BRAND.light,
            0.22,
          )} 0%, transparent 55%), radial-gradient(1000px 500px at -10% 0%, ${alpha(
            BRAND.pale,
            0.5,
          )} 0%, transparent 50%)`,
          backgroundAttachment: 'fixed',
        },
        '*::-webkit-scrollbar': { width: 10, height: 10 },
        '*::-webkit-scrollbar-thumb': {
          backgroundColor: alpha(BRAND.deep, 0.22),
          borderRadius: 8,
          border: '2px solid transparent',
          backgroundClip: 'content-box',
        },
        '*::-webkit-scrollbar-thumb:hover': {
          backgroundColor: alpha(BRAND.deep, 0.38),
        },
      },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        colorPrimary: {
          backgroundImage: `linear-gradient(120deg, ${BRAND.deep} 0%, ${BRAND.main} 70%, ${BRAND.light} 130%)`,
        },
        root: {
          boxShadow: `0 6px 20px ${alpha(BRAND.deep, 0.25)}`,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
        outlined: {
          borderColor: alpha(BRAND.deep, 0.12),
        },
        elevation1: {
          boxShadow: `0 2px 10px ${alpha(BRAND.deep, 0.08)}`,
        },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          border: `1px solid ${alpha(BRAND.deep, 0.1)}`,
          boxShadow: `0 8px 24px ${alpha(BRAND.deep, 0.08)}`,
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 8,
          paddingInline: 18,
        },
        containedPrimary: {
          color: '#ffffff',
          backgroundImage: `linear-gradient(120deg, ${BRAND.deep}, ${BRAND.main})`,
          boxShadow: `0 6px 16px ${alpha(BRAND.main, 0.35)}`,
          '&:hover': {
            color: '#ffffff',
            backgroundImage: `linear-gradient(120deg, ${BRAND.deep}, ${BRAND.deep})`,
            boxShadow: `0 8px 22px ${alpha(BRAND.deep, 0.4)}`,
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600 },
      },
    },
    MuiTableHead: {
      styleOverrides: {
        root: {
          '& .MuiTableCell-head': {
            backgroundColor: alpha(BRAND.pale, 0.45),
            color: BRAND.deep,
            fontWeight: 700,
            borderBottom: `1px solid ${alpha(BRAND.deep, 0.12)}`,
          },
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        hover: {
          '&:hover': {
            backgroundColor: `${alpha(BRAND.light, 0.1)} !important`,
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottomColor: alpha(BRAND.deep, 0.08),
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          backgroundColor: '#fff',
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: alpha(BRAND.deep, 0.2),
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: alpha(BRAND.main, 0.6),
          },
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          borderColor: alpha(BRAND.deep, 0.2),
          '&.Mui-selected': {
            backgroundColor: alpha(BRAND.main, 0.14),
            color: BRAND.deep,
            '&:hover': { backgroundColor: alpha(BRAND.main, 0.22) },
          },
        },
      },
    },
    MuiAvatar: {
      styleOverrides: {
        root: { fontWeight: 600 },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: BRAND.deep,
          fontSize: 12,
          borderRadius: 8,
        },
        arrow: { color: BRAND.deep },
      },
    },
  },
})

export default theme
