import PropTypes from "prop-types";

import { Box, Paper, Stack, Typography } from "@mui/material";

/** The centred card every sign-in step sits on, like Google's account pages. */
export default function AuthShell({ title, subtitle, children }) {
    return (
        <Box
            sx={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                bgcolor: "background.default",
                px: 2,
            }}
        >
            <Paper
                elevation={0}
                sx={{
                    width: "100%",
                    maxWidth: 448,
                    p: { xs: 3, sm: 5 },
                    borderRadius: 7,
                    border: 1,
                    borderColor: "divider",
                }}
            >
                <Stack spacing={1} alignItems="flex-start" mb={3}>
                    <Stack direction="row" spacing={1} alignItems="center">
                        <img
                            src="/CloudGram.svg"
                            width={40}
                            height={40}
                            alt=""
                        />
                        <Typography variant="h6" fontWeight={500}>
                            CloudGram
                        </Typography>
                    </Stack>
                    <Typography variant="h4" component="h1" pt={2}>
                        {title}
                    </Typography>
                    {subtitle && (
                        <Typography variant="body1" color="text.secondary">
                            {subtitle}
                        </Typography>
                    )}
                </Stack>
                {children}
            </Paper>
        </Box>
    );
}

AuthShell.propTypes = {
    title: PropTypes.node,
    subtitle: PropTypes.node,
    children: PropTypes.node,
};
