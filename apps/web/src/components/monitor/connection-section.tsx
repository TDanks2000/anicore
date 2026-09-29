import { Server, ShieldCheck } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";
import { KeyValue } from "./stats";

export function ConnectionSection(props: {
  apiUrl: string;
  onApiUrlChange: (value: string) => void;
  accessCode: string;
  onAccessCodeChange: (value: string) => void;
  lastRefresh: string | null;
}) {
  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Point this app at the API host exposing `/sync-monitor`.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(240px,360px)]">
          <label className="flex flex-col gap-2 text-sm font-medium">
            API URL
            <Input
              value={props.apiUrl}
              onChange={(event) => props.onApiUrlChange(event.target.value)}
              placeholder="http://192.168.1.45:3000"
              autoComplete="url"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium">
            Monitor code
            <Input
              value={props.accessCode}
              onChange={(event) => props.onAccessCodeChange(event.target.value)}
              placeholder="Paste access code"
              type="password"
              autoComplete="current-password"
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Endpoint</CardTitle>
          <CardDescription>
            {props.lastRefresh
              ? `Last refresh ${formatDate(props.lastRefresh)}`
              : "Not refreshed yet"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <KeyValue
            label={
              <>
                <Server />
                API
              </>
            }
          >
            <span className="max-w-44">{props.apiUrl}</span>
          </KeyValue>
          <KeyValue
            label={
              <>
                <ShieldCheck />
                Auth
              </>
            }
          >
            {props.accessCode ? "Code set" : "Missing"}
          </KeyValue>
        </CardContent>
      </Card>
    </section>
  );
}
