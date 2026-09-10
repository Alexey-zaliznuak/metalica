import type { ReactNode } from 'react'
import { Box } from '@mui/material'

export const attachmentActionSx = {
  width: '100%',
  minWidth: 0,
  minHeight: 36,
  borderRadius: 0,
  justifyContent: 'flex-start',
  px: 1.5,
  py: 0.875,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.4,
  textAlign: 'left',
  textTransform: 'none',
  '& .MuiButton-startIcon': { ml: 0, mr: 1, flexShrink: 0 },
  '& .MuiButton-startIcon > *:nth-of-type(1)': { fontSize: 18 },
} as const

export default function AttachmentCard({ children }: { children: ReactNode }) {
  return (
    <Box sx={{
      width: 240,
      maxWidth: '100%',
      minWidth: 0,
      border: '1px solid',
      borderColor: 'divider',
      borderRadius: 1,
      overflow: 'hidden',
      bgcolor: 'background.paper',
      color: 'text.primary',
    }}>
      {children}
    </Box>
  )
}
